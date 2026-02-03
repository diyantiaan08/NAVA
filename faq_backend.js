// Simple Express backend for FAQ add endpoint
const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

const DATA_PATH = path.join(__dirname, 'data', 'faq.json');

// Helper: load & save JSON
function loadFaq() {
  return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
}
function saveFaq(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// Endpoint: tambah pertanyaan ke kategori
app.post('/faq/add', (req, res) => {
  const { kategori, pertanyaan, jawaban } = req.body;
  if (!kategori || !pertanyaan || !jawaban) {
    return res.status(400).json({ error: 'kategori, pertanyaan, dan jawaban wajib diisi' });
  }
  let data = loadFaq();
  let kat = data.find(k => k.kategori.toLowerCase() === kategori.toLowerCase());
  if (!kat) {
    return res.status(404).json({ error: 'Kategori tidak ditemukan' });
  }
  kat.faq.push({ pertanyaan, jawaban });
  saveFaq(data);
  res.json({ success: true, message: 'FAQ berhasil ditambahkan' });
});

// Endpoint: ambil list kategori
app.get('/faq/categories', (req, res) => {
  let data = loadFaq();
  res.json(data.map(k => k.kategori));
});



// Qdrant semantic search

const axios = require('axios');
const stringSimilarity = require('string-similarity');


async function getEmbedding(text) {
  // Panggil microservice Python
  const res = await axios.post('http://localhost:5001/embed', { texts: [text] });
  return res.data.vectors[0];
}

async function searchQdrant(embedding, kategori) {
  const url = 'http://localhost:6333/collections/faq_semantic/points/search';
  const filter = kategori ? {
    must: [{ key: 'kategori', match: { value: kategori } }]
  } : undefined;
  const body = {
    vector: embedding,
    filter,
    top: 3, // Ambil 3 teratas
    with_payload: true
  };
  const res = await axios.post(url, body);
  return res.data.result || [];
}

// Endpoint POST /faq/askdy
app.post('/faq/ask', async (req, res) => {
  const { kategori, pertanyaan } = req.body;
  if (!kategori || !pertanyaan) {
    return res.status(400).json({ error: 'kategori dan pertanyaan wajib diisi' });
  }
  try {
    const embedding = await getEmbedding(pertanyaan);
    const results = await searchQdrant(embedding, kategori.toUpperCase());
    if (!results.length) {
      return res.status(404).json({ error: 'Jawaban tidak ditemukan di Qdrant' });
    }
    // Ambil top-5
    const topResults = results.slice(0, 5);
    const threshold = 0.6;
    // Jika pertanyaan user mengandung 'fungsi' atau 'buat apa', prioritaskan hasil yang mengandung 'fungsi' atau 'kegunaan'
    const lowerQ = pertanyaan.toLowerCase();
    let final = topResults[0];
    if (lowerQ.includes('fungsi') || lowerQ.includes('buat apa')) {
      const fungsiResult = topResults.find(r =>
        r.payload.pertanyaan.toLowerCase().includes('fungsi') ||
        r.payload.pertanyaan.toLowerCase().includes('kegunaan')
      );
      if (fungsiResult) final = fungsiResult;
    } else {
      // Fuzzy match di top-5
      const pertanyaanList = topResults.map(r => r.payload.pertanyaan);
      const fuzzy = stringSimilarity.findBestMatch(pertanyaan, pertanyaanList);
      const idx = fuzzy.bestMatchIndex;
      if (topResults[idx].score >= threshold || fuzzy.bestMatch.rating >= 0.5) {
        final = topResults[idx];
      }
    }
    if (final.score < threshold) {
      return res.status(404).json({ error: 'Tidak ada jawaban relevan (semantic/fuzzy)' });
    }
    res.json({ jawaban: final.payload.jawaban, pertanyaan: final.payload.pertanyaan, score: final.score });
  } catch (err) {
    res.status(500).json({ error: 'Gagal query ke Qdrant', detail: err.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FAQ backend listening on port ${PORT}`);
});
