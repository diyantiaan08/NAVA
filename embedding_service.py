from flask import Flask, request, jsonify
from sentence_transformers import SentenceTransformer

app = Flask(__name__)
# Ganti model di sini jika ingin model Indo lain
model = SentenceTransformer('distiluse-base-multilingual-cased-v2')

@app.route('/embed', methods=['POST'])
def embed():
    data = request.json
    texts = data.get('texts', [])
    if not texts:
        return jsonify({'error': 'No texts provided'}), 400
    vectors = model.encode(texts).tolist()
    return jsonify({'vectors': vectors})

if __name__ == '__main__':
    app.run(port=5001)
