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

// Normalize answer newlines and provide alternate formats for FE rendering
function formatAnswer(text) {
  const raw = (text || '');
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const plain = normalized.replace(/\n/g, ' ');
  return { jawaban: plain };
}

// Fungsi fuzzy match sederhana
function findBestMatch(pertanyaanUser, daftarFaq) {
  const stringSimilarity = require('string-similarity');
  pertanyaanUser = pertanyaanUser.toLowerCase().trim();
  // Normalisasi pertanyaan FAQ dan user: lowercase, trim, hilangkan spasi ganda
  function normalize(str) {
    return str.toLowerCase().replace(/\s+/g, ' ').trim();
  }
  const normUser = normalize(pertanyaanUser);
  const faqQuestions = daftarFaq.map(item => normalize(item.pertanyaan));
  // Prioritas exact match setelah normalisasi
  const exactIdx = faqQuestions.findIndex(q => q === normUser);
  if (exactIdx !== -1) {
    return { ...daftarFaq[exactIdx], score: 1 };
  }
  // Jika tidak ada exact match, pakai similarity
  const matches = stringSimilarity.findBestMatch(pertanyaanUser, faqQuestions);
  const bestIndex = matches.bestMatchIndex;
  const bestScore = matches.bestMatch.rating;
  if (bestScore >= 0.8) {
    return { ...daftarFaq[bestIndex], score: bestScore };
  }
  return null;
}

// Endpoint POST /faq/ask
app.post('/faq/ask', (req, res) => {
  const { kategori, pertanyaan } = req.body;
  if (!kategori || !pertanyaan) {
    return res.status(400).json({ error: 'kategori dan pertanyaan wajib diisi' });
  }
  const data = loadFaq();
  // Cari kategori secara case-insensitive
  const kat = data.find(k => k.kategori.toLowerCase() === kategori.toLowerCase());
  if (!kat) {
    return res.status(404).json({ error: 'Kategori tidak ditemukan' });
  }
  const match = findBestMatch(pertanyaan, kat.faq);
  if (!match) {
    return res.status(404).json({ error: 'Pertanyaan tidak ditemukan atau tidak mirip' });
  }
  // Kembalikan pertanyaan, skor, dan jawaban yang sudah dinormalisasi
  const formatted = formatAnswer(match.jawaban);
  res.json({ pertanyaan: match.pertanyaan, score: match.score, jawaban: formatted.jawaban });
});

module.exports = app;
