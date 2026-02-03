# Script untuk cek isi collection Qdrant
from qdrant_client import QdrantClient

QDRANT_URL = 'http://localhost:6333'
COLLECTION_NAME = 'faq_semantic'

client = QdrantClient(QDRANT_URL)

# Ambil info collection
info = client.get_collection(COLLECTION_NAME)
print('Collection info:', info)

# Ambil 5 data pertama
points = client.scroll(collection_name=COLLECTION_NAME, limit=5)
for p in points[0]:
    print('ID:', p.id)
    print('Payload:', p.payload)
    print('---')
