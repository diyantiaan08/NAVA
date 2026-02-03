# Script: embed_and_index_qdrant.py
# Fungsi: Generate embedding pertanyaan FAQ dan index ke Qdrant
# Prasyarat: pip install qdrant-client sentence-transformers tqdm

import json
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

# Load model embedding (IndoBERT atau multilingual)
model = SentenceTransformer('distiluse-base-multilingual-cased-v2')

# Generate embedding
pertanyaan_list = [item['pertanyaan'] for item in faq_flat]
embeddings = model.encode(pertanyaan_list, show_progress_bar=True)

# Init Qdrant client
client = QdrantClient(QDRANT_URL)

# Buat collection jika belum ada
client.recreate_collection(
    collection_name=COLLECTION_NAME,
    vectors_config=qmodels.VectorParams(size=embeddings.shape[1], distance="Cosine")
)

# Index ke Qdrant
points = []
for idx, (item, emb) in enumerate(zip(faq_flat, embeddings)):
    points.append(qmodels.PointStruct(
        id=idx,
        vector=emb.tolist(),
        payload={
            'kategori': item['kategori'],
            'pertanyaan': item['pertanyaan'],
            'jawaban': item['jawaban']
        }
    ))

client.upsert(collection_name=COLLECTION_NAME, points=points)
print(f"Indexing ke Qdrant selesai. Total: {len(points)} pertanyaan.")
