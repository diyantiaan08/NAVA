# Test endpoint embedding microservice
import requests

url = 'http://localhost:5001/embed'
data = {"texts": ["Laporan penjualan margin buat apa?"]}

r = requests.post(url, json=data)
print('Status:', r.status_code)
print('Response:', r.json())
