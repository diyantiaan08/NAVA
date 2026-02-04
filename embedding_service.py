import os
import requests
from flask import Flask, request, jsonify
from sentence_transformers import SentenceTransformer

app = Flask(__name__)

# Config: switch between local SentenceTransformer and Ollama embeddings
USE_OLLAMA_EMBED = (os.environ.get('USE_OLLAMA_EMBED') or '0') == '1'
OLLAMA_URL = os.environ.get('OLLAMA_URL', 'http://127.0.0.1:11434')
OLLAMA_EMBED_MODEL = os.environ.get('OLLAMA_EMBED_MODEL', 'nomic-embed-text')

# Local embedding model (used when USE_OLLAMA_EMBED=0)
st_model = None
if not USE_OLLAMA_EMBED:
    # Ganti model di sini jika ingin model Indo lain
    st_model = SentenceTransformer('distiluse-base-multilingual-cased-v2')

def embed_with_ollama(texts):
    vectors = []
    for t in texts:
        payload = { 'model': OLLAMA_EMBED_MODEL, 'prompt': t }
        r = requests.post(f"{OLLAMA_URL}/api/embeddings", json=payload, timeout=30)
        if r.status_code != 200:
            raise RuntimeError(f"Ollama embeddings error {r.status_code}: {r.text}")
        data = r.json()
        vec = data.get('embedding') or data.get('data', [{}])[0].get('embedding')
        if not vec:
            raise RuntimeError('Invalid embedding response from Ollama')
        vectors.append(vec)
    return vectors

@app.route('/embed', methods=['POST'])
def embed():
    data = request.json
    texts = data.get('texts', [])
    if not texts:
        return jsonify({'error': 'No texts provided'}), 400
    if USE_OLLAMA_EMBED:
        vectors = embed_with_ollama(texts)
    else:
        vectors = st_model.encode(texts).tolist()
    return jsonify({'vectors': vectors})

if __name__ == '__main__':
    app.run(port=5001)
