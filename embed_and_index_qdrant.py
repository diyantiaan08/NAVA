# Script: embed_and_index_qdrant.py
# Fungsi: Generate embedding pertanyaan FAQ dan index ke Qdrant
# Prasyarat: pip install qdrant-client sentence-transformers tqdm

import os
import json
import requests
from qdrant_client import QdrantClient
from qdrant_client.http import models as qmodels
from sentence_transformers import SentenceTransformer
from tqdm import tqdm

# Konfigurasi Qdrant
QDRANT_URL = 'http://localhost:6333'  # ganti jika pakai cloud
COLLECTION_NAME = 'faq_semantic'

# Load data FAQ
with open('data/faq.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

# Flatten data: satu list berisi dict kategori, pertanyaan, jawaban
faq_flat = []
for kat in data:
    for item in kat['faq']:
        faq_flat.append({
            'kategori': kat['kategori'],
            'pertanyaan': item['pertanyaan'],
            'jawaban': item['jawaban']
        })

USE_OLLAMA_EMBED = (os.environ.get('USE_OLLAMA_EMBED') or '0') == '1'
OLLAMA_URL = os.environ.get('OLLAMA_URL', 'http://127.0.0.1:11434')
OLLAMA_EMBED_MODEL = os.environ.get('OLLAMA_EMBED_MODEL', 'nomic-embed-text')

def embed_with_ollama(texts):
    vectors = []
    for t in texts:
        payload = { 'model': OLLAMA_EMBED_MODEL, 'prompt': t }
        r = requests.post(f"{OLLAMA_URL}/api/embeddings", json=payload, timeout=30)
        if r.status_code != 200:
            raise RuntimeError(f"Ollama embeddings error {r.status_code}: {r.text}")
        data = r.json()
        vec = data.get('embedding') or (data.get('data') or [{}])[0].get('embedding')
        if not vec:
            raise RuntimeError('Invalid embedding response from Ollama')
        vectors.append(vec)
    return vectors

model = None
if not USE_OLLAMA_EMBED:
    # Load model embedding (IndoBERT atau multilingual)
    model = SentenceTransformer('distiluse-base-multilingual-cased-v2')

# Generate embedding
pertanyaan_list = [item['pertanyaan'] for item in faq_flat]
if USE_OLLAMA_EMBED:
    embeddings = embed_with_ollama(pertanyaan_list)
else:
    embeddings = model.encode(pertanyaan_list, show_progress_bar=True).tolist()

# Init Qdrant client
client = QdrantClient(QDRANT_URL)

# Buat collection jika belum ada
client.recreate_collection(
    collection_name=COLLECTION_NAME,
    vectors_config=qmodels.VectorParams(size=len(embeddings[0]), distance="Cosine")
)

# Index ke Qdrant
points = []
for idx, (item, emb) in enumerate(zip(faq_flat, embeddings)):
    points.append(qmodels.PointStruct(
        id=idx,
        vector=emb,
        payload={
            'kategori': item['kategori'],
            'pertanyaan': item['pertanyaan'],
            'jawaban': item['jawaban']
        }
    ))

client.upsert(collection_name=COLLECTION_NAME, points=points)
print(f"Indexing ke Qdrant selesai. Total: {len(points)} pertanyaan.")
