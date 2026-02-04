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

// Normalize answer newlines to spaces (previous behavior)
function formatAnswer(text) {
  const raw = (text || '');
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const plain = normalized.replace(/\n/g, ' ');
  return { jawaban: plain };
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

// Ollama config
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:1.7b';
const OLLAMA_TIMEOUT = parseInt(process.env.OLLAMA_TIMEOUT || '20000', 10);
const USE_LLM_DEFAULT = (process.env.USE_LLM || '0') === '1';

async function generateWithOllama(prompt) {
  const url = `${OLLAMA_URL}/api/generate`;
  const body = {
    model: OLLAMA_MODEL,
    prompt,
    stream: false,
    options: {
      temperature: 0.2,
      num_ctx: 4096
    }
  };
  try {
    const res = await axios.post(url, body, { timeout: OLLAMA_TIMEOUT });
    return (res.data && res.data.response) ? res.data.response : '';
  } catch (e) {
    // Re-throw with helpful message
    if (e.response && e.response.status === 404) {
      const hint = `Ollama 404: model \"${OLLAMA_MODEL}\" tidak ditemukan atau Ollama belum berjalan. Jalankan: 'ollama serve' lalu 'ollama pull ${OLLAMA_MODEL}'.`;
      const err = new Error(hint);
      err.code = 404;
      throw err;
    }
    if (e.code === 'ECONNREFUSED') {
      const err = new Error(`Tidak bisa konek ke Ollama di ${OLLAMA_URL}. Pastikan layanan berjalan: 'ollama serve'.`);
      err.code = 'ECONNREFUSED';
      throw err;
    }
    throw e;
  }
}

async function getOllamaTags() {
  const url = `${OLLAMA_URL}/api/tags`;
  const res = await axios.get(url, { timeout: OLLAMA_TIMEOUT });
  return res.data && res.data.models ? res.data.models : [];
}

function buildOllamaPrompt(question, topResults) {
  const contextBlocks = topResults.map((r, i) => `#${i + 1} Pertanyaan: ${r.payload.pertanyaan}\nJawaban: ${r.payload.jawaban}`).join('\n\n');
  const instructions = [
    'Anda adalah asisten FAQ perusahaan. Jawab dalam bahasa Indonesia.',
    'Gunakan hanya informasi pada konteks di bawah ini. Jangan membuat informasi baru.',
    'Jika jawaban tidak ada di konteks, balas singkat: "Maaf, belum ada jawaban."',
    'Ringkas dan jelas, maksimal 1-2 kalimat.'
  ].join(' ');
  return `${instructions}\n\nPertanyaan pengguna: ${question}\n\nKonteks:\n${contextBlocks}\n\nJawaban:`;
}


async function getEmbedding(text) {
  // Panggil microservice Python (yang bisa pakai SentenceTransformer atau Ollama embeddings)
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
    top: 10, // Ambil lebih banyak kandidat agar peluang exact match masuk
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
    // Normalisasi pertanyaan untuk membuat hasil tidak sensitif huruf besar/kecil dan tanda baca
    const normalizeSpaces = s => (s || '').replace(/\s+/g, ' ').trim();
    const stripPunct = s => (s || '').replace(/[\?\.!,:;"'()\[\]{}]/g, '');
    const toLower = s => (s || '').toLowerCase();
    const canonicalize = s => s
      .replace(/\bstock\b/g, 'stok')
      .replace(/\bmargin penjualan\b/g, 'penjualan margin')
      .replace(/\bmelihat\b/g, 'lihat')
      .replace(/\bgimana\b/g, 'bagaimana');
    const normalizeFull = s => canonicalize(normalizeSpaces(stripPunct(toLower(s))));

    const normalizedQuestion = normalizeSpaces(toLower(pertanyaan || ''));

    // Short-circuit: exact match over full kategori (ignoring punctuation/case)
    const dataAll = loadFaq();
    const katObj = dataAll.find(k => k.kategori.toLowerCase() === kategori.toLowerCase());
    // Jika kategori tidak ditemukan, langsung fallback sesuai instruksi prompt
    if (!katObj) {
      const useLlmCat = USE_LLM_DEFAULT || req.query.llm === '1' || req.body.use_llm === true;
      if (useLlmCat) {
        try {
          const prompt = buildOllamaPrompt(pertanyaan, []);
          const llmOutput = await generateWithOllama(prompt);
          const llmAnswer = formatAnswer(llmOutput).jawaban;
          return res.json({ mode: 'llm-no-category', pertanyaan, score: 0, jawaban: llmAnswer });
        } catch (e) {
          return res.status(404).json({ error: 'Maaf, belum ada jawaban.' });
        }
      }
      return res.status(404).json({ error: 'Maaf, belum ada jawaban.' });
    }
    if (katObj && Array.isArray(katObj.faq)) {
      // Early rule-based override: prefer Q dengan 'informasi/ditampilkan' yang memuat semua token topik dari query
      const stopEarly = new Set(['yang','atau','dari','dalam','pada','untuk','dengan','apa','saja','anda','dan','di','ke','ini','itu','bagaimana','gimana','cara']);
      const allTokensEarly = normalizeFull(normalizedQuestion).split(' ');
      const qTokensEarly = allTokensEarly.filter(t => t.length >= 3 && !stopEarly.has(t));
      const wantsInfoEarly = allTokensEarly.includes('lihat') || allTokensEarly.includes('informasi') || allTokensEarly.includes('ditampilkan');
      if (wantsInfoEarly && qTokensEarly.length) {
        const preferredEarly = katObj.faq.find(f => {
          const qn = normalizeFull(f.pertanyaan);
          if (!(qn.includes('informasi') || qn.includes('ditampilkan'))) return false;
          // kandidat harus memuat semua token topik dari query (mis. 'stok', 'jual')
          return qTokensEarly.every(tok => qn.includes(tok));
        });
        if (preferredEarly) {
          const formattedPref = formatAnswer(preferredEarly.jawaban);
          return res.json({ pertanyaan: preferredEarly.pertanyaan, score: 0.99, jawaban: formattedPref.jawaban, mode: 'rule-early' });
        }
      }
      const normQ = normalizeFull(pertanyaan);
      const exact = katObj.faq.find(f => normalizeFull(f.pertanyaan) === normQ);
      if (exact) {
        const formatted = formatAnswer(exact.jawaban);
        return res.json({ pertanyaan: exact.pertanyaan, score: 1, jawaban: formatted.jawaban, mode: 'exact' });
      }
      // Local fuzzy fallback before semantic search
      try {
        const candidates = katObj.faq.map(f => ({ item: f, norm: normalizeFull(f.pertanyaan) }));
        const match = stringSimilarity.findBestMatch(normQ, candidates.map(c => c.norm));
        const best = candidates[match.bestMatchIndex];
        if (match.bestMatch.rating >= 0.6) {
          const formatted = formatAnswer(best.item.jawaban);
          return res.json({ pertanyaan: best.item.pertanyaan, score: match.bestMatch.rating, jawaban: formatted.jawaban, mode: 'local-fuzzy' });
        }
      } catch (_) { /* ignore and continue to semantic search */ }
    }
    let results = [];
    let embedding = null;
    try {
      embedding = await getEmbedding(normalizedQuestion);
      results = await searchQdrant(embedding, kategori.toUpperCase());
    } catch (e) {
      // Qdrant 400 often means embedding dimension mismatch
      const dataAll2 = loadFaq();
      const katObj2 = dataAll2.find(k => k.kategori.toLowerCase() === kategori.toLowerCase());
      if (e.response && e.response.status === 400 && katObj2 && Array.isArray(katObj2.faq)) {
        // Fallback: local fuzzy search within category
        const normalizeSpaces2 = s => (s || '').replace(/\s+/g, ' ').trim();
        const stripPunct2 = s => (s || '').replace(/[\?\.!,:;"'()\[\]{}]/g, '');
        const toLower2 = s => (s || '').toLowerCase();
        const canonicalize2 = s => s
          .replace(/\bstock\b/g, 'stok')
          .replace(/\bmargin penjualan\b/g, 'penjualan margin');
        const normalizeFull2 = s => canonicalize2(normalizeSpaces2(stripPunct2(toLower2(s))));
        const normQ2 = normalizeFull2(pertanyaan);
        const candidates = katObj2.faq.map(f => ({
          item: f,
          norm: normalizeFull2(f.pertanyaan)
        }));
        const stringSimilarity = require('string-similarity');
        const match = stringSimilarity.findBestMatch(normQ2, candidates.map(c => c.norm));
        const best = candidates[match.bestMatchIndex];
        if (match.bestMatch.rating >= 0.6) {
          const formatted = formatAnswer(best.item.jawaban);
          return res.json({ pertanyaan: best.item.pertanyaan, score: match.bestMatch.rating, jawaban: formatted.jawaban, mode: 'fallback-local' });
        }
        return res.status(500).json({ error: 'Gagal query ke Qdrant', detail: 'Kemungkinan mismatch dimensi embedding. Pastikan layanan embedding dan indeks memakai model yang sama.', hint: 'Restart embedding_service dengan USE_OLLAMA_EMBED sesuai, lalu reindex.' });
      }
      if (e.response && e.response.status === 400) {
        // Jika 400 tapi kategori tidak valid/atau tidak ada fallback lokal, gunakan LLM/atau balasan default
        const useLlmErr = USE_LLM_DEFAULT || req.query.llm === '1' || req.body.use_llm === true;
        if (useLlmErr) {
          try {
            const prompt = buildOllamaPrompt(pertanyaan, []);
            const llmOutput = await generateWithOllama(prompt);
            const llmAnswer = formatAnswer(llmOutput).jawaban;
            return res.json({ mode: 'llm-error-400', pertanyaan, score: 0, jawaban: llmAnswer });
          } catch (e2) {
            return res.status(404).json({ error: 'Maaf, belum ada jawaban.' });
          }
        }
        return res.status(404).json({ error: 'Maaf, belum ada jawaban.' });
      }
      // Non-400 or no category, propagate
      throw e;
    }
    if (!results.length) {
      const useLlm = USE_LLM_DEFAULT || req.query.llm === '1' || req.body.use_llm === true;
      if (useLlm) {
        try {
          const prompt = buildOllamaPrompt(pertanyaan, []);
          const llmOutput = await generateWithOllama(prompt);
          const llmAnswer = formatAnswer(llmOutput).jawaban;
          return res.json({ mode: 'llm-empty', pertanyaan, score: 0, jawaban: llmAnswer });
        } catch (e) {
          // Fall back to explicit message
          return res.status(404).json({ error: 'Maaf, belum ada jawaban.' });
        }
      }
      return res.status(404).json({ error: 'Maaf, belum ada jawaban.' });
    }
    // Ambil top-5
    const topResults = results.slice(0, 5);
    const threshold = 0.6;
    // Hybrid reranker: gabungkan kandidat Qdrant + kandidat leksikal dari kategori
    const lowerQ = normalizedQuestion;
    const normalize = s => normalizeFull(s);
    const queryNorm = normalize(lowerQ);
    const queryTokens = queryNorm.split(' ').filter(t => t.length >= 3 && !['yang','atau','dari','dalam','pada','untuk','dengan','apa','saja','anda','dan','di','ke','ini','itu'].includes(t));
    const containsKeyword = kw => queryTokens.includes(kw);

    let lexicalCandidates = [];
    if (katObj && Array.isArray(katObj.faq)) {
      lexicalCandidates = katObj.faq
        .map(f => ({ item: f, norm: normalize(f.pertanyaan) }))
        .filter(c => queryTokens.some(t => c.norm.includes(t)))
        .slice(0, 50);
    }

    // Rule-based override (umum): prefer Q 'informasi/ditampilkan' yang memuat semua token topik dari query
    const queryWantsInfo = queryTokens.includes('lihat') || queryTokens.includes('informasi') || queryTokens.includes('ditampilkan');
    if (queryWantsInfo && queryTokens.length && katObj && Array.isArray(katObj.faq)) {
      const preferred = katObj.faq.find(f => {
        const qn = normalize(f.pertanyaan);
        if (!(qn.includes('informasi') || qn.includes('ditampilkan'))) return false;
        return queryTokens.every(tok => qn.includes(tok));
      });
      if (preferred) {
        const formattedPref = formatAnswer(preferred.jawaban);
        return res.json({ pertanyaan: preferred.pertanyaan, score: 0.99, jawaban: formattedPref.jawaban, mode: 'rule' });
      }
    }

    const candidateMap = new Map();
    // Masukkan kandidat dari Qdrant
    topResults.forEach(r => {
      const key = r.payload.pertanyaan;
      if (!candidateMap.has(key)) {
        candidateMap.set(key, { source: 'qdrant', qdrantScore: r.score || 0, item: r.payload });
      } else {
        const ref = candidateMap.get(key);
        ref.qdrantScore = Math.max(ref.qdrantScore, r.score || 0);
      }
    });
    // Masukkan kandidat leksikal
    lexicalCandidates.forEach(c => {
      const key = c.item.pertanyaan;
      if (!candidateMap.has(key)) {
        candidateMap.set(key, { source: 'lexical', qdrantScore: 0, item: c.item });
      }
    });

    const compareTwo = stringSimilarity.compareTwoStrings;
    const scored = Array.from(candidateMap.values()).map(c => {
      const candQ = normalize(c.item.pertanyaan);
      const candTokens = candQ.split(' ').filter(t => t.length >= 3);
      const inter = candTokens.filter(t => queryTokens.includes(t));
      const union = Array.from(new Set([...candTokens, ...queryTokens]));
      const overlap = union.length ? (inter.length / union.length) : 0;
      const sim = compareTwo(queryNorm, candQ); // 0..1
      const keyword = containsKeyword('margin')
        ? (candQ.includes('margin') ? 0.12 : -0.06)
        : 0;
      // Heuristic: prefer 'informasi'/'ditampilkan' when query asks what can be seen
      const queryWantsInfo = queryTokens.includes('lihat') || queryTokens.includes('informasi') || queryTokens.includes('ditampilkan');
      let infoBoost = 0;
      if (queryWantsInfo) {
        if (candQ.includes('informasi apa saja') || candQ.startsWith('informasi')) {
          infoBoost += 0.35;
        } else if (candQ.includes('informasi') || candQ.includes('ditampilkan')) {
          infoBoost += 0.20;
        } else if (candQ.includes('fungsi') || candQ.includes('buat apa')) {
          infoBoost -= 0.25;
        }
      }
      const composite = (0.60 * c.qdrantScore) + (0.28 * sim) + (0.12 * overlap) + keyword + infoBoost;
      return { ...c, sim, overlap, composite };
    });

    // Pilih skor komposit tertinggi
    scored.sort((a, b) => b.composite - a.composite);
    const best = scored[0];
    if (!best || best.composite < 0.52) {
      return res.status(404).json({ error: 'Maaf, kami belum menemukan jawaban yang sesuai. Silakan perjelas pertanyaan atau pilih kategori yang tersedia.' });
    }
    const formatted = formatAnswer(best.item.jawaban);

    const useLlm = USE_LLM_DEFAULT || req.query.llm === '1' || req.body.use_llm === true;
    if (useLlm) {
      try {
        // Pakai konteks dari gabungan kandidat terbaik (ambil 5 teratas)
        const ctxTop = scored.slice(0, 5).map(s => ({ payload: { pertanyaan: s.item.pertanyaan, jawaban: s.item.jawaban } }));
        const prompt = buildOllamaPrompt(pertanyaan, ctxTop);
        const llmOutput = await generateWithOllama(prompt);
        const llmAnswer = formatAnswer(llmOutput).jawaban;
        return res.json({
          mode: 'llm',
          pertanyaan: best.item.pertanyaan,
          score: best.qdrantScore || best.sim,
          jawaban: llmAnswer
        });
      } catch (e) {
        // Fallback to retrieved answer, include clearer error
        return res.json({
          mode: 'fallback',
          pertanyaan: best.item.pertanyaan,
          score: best.qdrantScore || best.sim,
          jawaban: formatted.jawaban,
          llmError: e && e.message ? e.message : 'LLM gagal'
        });
      }
    }
    // Default: return retrieved answer only
    res.json({ pertanyaan: best.item.pertanyaan, score: best.qdrantScore || best.sim, jawaban: formatted.jawaban });
  } catch (err) {
    const useLlmAny = USE_LLM_DEFAULT || req.query.llm === '1' || req.body.use_llm === true;
    if (useLlmAny) {
      try {
        const prompt = buildOllamaPrompt(pertanyaan, []);
        const llmOutput = await generateWithOllama(prompt);
        const llmAnswer = formatAnswer(llmOutput).jawaban;
        return res.json({ mode: 'llm-catch', pertanyaan, score: 0, jawaban: llmAnswer });
      } catch (e) {
        return res.status(404).json({ error: 'Maaf, belum ada jawaban.' });
      }
    }
    return res.status(404).json({ error: 'Maaf, belum ada jawaban.' });
  }
});

// Health check for Ollama
app.get('/health/ollama', async (req, res) => {
  try {
    const tags = await getOllamaTags();
    const hasModel = !!tags.find(m => m.name === OLLAMA_MODEL);
    if (!hasModel) {
      return res.status(404).json({
        ok: false,
        error: `Model \"${OLLAMA_MODEL}\" belum ada di Ollama. Jalankan: ollama pull ${OLLAMA_MODEL}`,
        available: tags.map(m => m.name)
      });
    }
    // Quick ping by attempting a trivial generation
    const out = await generateWithOllama('Balas "OK" jika siap.');
    res.json({ ok: true, model: OLLAMA_MODEL, response: out.slice(0, 50) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FAQ backend listening on port ${PORT}`);
});
