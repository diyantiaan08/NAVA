// Endpoint /faq/ask untuk mencari jawaban berdasarkan kategori dan pertanyaan user
// Tambahkan ke backend Express yang sudah ada
const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

const DATA_PATH = path.join(__dirname, 'data', 'faq.json');

function loadFaq() {
  return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
}

// Fungsi fuzzy match sederhana
function findBestMatch(pertanyaanUser, daftarFaq) {
  pertanyaanUser = pertanyaanUser.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const item of daftarFaq) {
    const q = item.pertanyaan.toLowerCase();
    let score = 0;
    if (q === pertanyaanUser) score = 100;
    else if (q.includes(pertanyaanUser) || pertanyaanUser.includes(q)) score = 80;
    else {
      // Skor berdasarkan jumlah kata yang sama
      const qWords = new Set(q.split(' '));
      const userWords = new Set(pertanyaanUser.split(' '));
      const intersection = [...qWords].filter(x => userWords.has(x));
      score = intersection.length * 10;
    }
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return bestScore >= 30 ? best : null; // threshold
}

// Endpoint POST /faq/ask
app.post('/faq/ask', (req, res) => {
  const { kategori, pertanyaan } = req.body;
  if (!kategori || !pertanyaan) {
    return res.status(400).json({ error: 'kategori dan pertanyaan wajib diisi' });
  }
  const data = loadFaq();
  const kat = data.find(k => k.kategori === kategori);
  if (!kat) {
    return res.status(404).json({ error: 'Kategori tidak ditemukan' });
  }
  const match = findBestMatch(pertanyaan, kat.faq);
  if (!match) {
    return res.status(404).json({ error: 'Pertanyaan tidak ditemukan atau tidak mirip' });
  }
  res.json({ jawaban: match.jawaban });
});

module.exports = app;
