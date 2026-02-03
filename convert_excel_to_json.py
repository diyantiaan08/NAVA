# Script: convert_excel_to_json.py
# Fungsi: Membaca file NAVA_Knowledge_Kategori.xls dan output ke data/faq.json

import pandas as pd
import json
from collections import defaultdict

# Path file
excel_path = 'NAVA_Knowledge_Kategori.xls'
json_path = 'data/faq.json'


# Baca Excel (header di baris ke-3, kolom: Kategori, Question, Answer)
df = pd.read_excel(excel_path, header=2)

# Struktur: kategori -> array pertanyaan & jawaban
kategori_dict = defaultdict(list)
for _, row in df.iterrows():
    kategori = str(row['Kategori']).strip()
    pertanyaan = str(row['Question']).strip()
    jawaban = str(row['Answer']).strip()
    if kategori and pertanyaan and jawaban:
        kategori_dict[kategori].append({
            'pertanyaan': pertanyaan,
            'jawaban': jawaban
        })

# Format akhir
result = [
    {'kategori': k, 'faq': v}
    for k, v in kategori_dict.items()
]

# Simpan ke JSON
with open(json_path, 'w', encoding='utf-8') as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

print(f'Konversi selesai. Data disimpan di {json_path}')
