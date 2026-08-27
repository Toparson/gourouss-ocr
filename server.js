const express = require('express');
const { createWorker } = require('tesseract.js');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SHARED_SECRET = process.env.WEBHOOK_SECRET; // secret partagé avec le trigger Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requis (variables d\'environnement Render).');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ===================================================================
// Extraction "au mieux" à partir du texte OCR brut.
// ⚠️ PROVISOIRE : regex génériques pour reçus mobile money en FCFA/XAF.
// À calibrer avec de vraies captures Airtel Money / Moov Money dès
// qu'on les a — les libellés exacts ("Montant", "Vous avez envoyé",
// mise en forme des séparateurs de milliers, etc.) varient d'une app
// à l'autre et je n'ai pas encore vu de vrai reçu.
// ===================================================================

function extractAmount(text) {
  const patterns = [
    /(?:montant|amount|envoy[ée])\s*[:\-]?\s*([\d][\d\s.,]{2,})\s*(?:f\s?cfa|xaf|fcfa)/i,
    /([\d][\d\s.,]{2,})\s*(?:f\s?cfa|xaf|fcfa)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const raw = m[1].replace(/[\s.,](?=\d{3}(\D|$))/g, '');
      const num = parseFloat(raw.replace(',', '.'));
      if (!isNaN(num)) return num;
    }
  }
  return null;
}

function extractPhone(text) {
  const m = text.match(/(?:\+?235[\s.-]?)?(\d{2}[\s.-]?\d{2}[\s.-]?\d{2}[\s.-]?\d{2})\b/);
  return m ? m[0].replace(/[\s.-]/g, '') : null;
}

function extractReference(text) {
  const m = text.match(/(?:r[ée]f(?:[ée]rence)?|id\s*transaction|n[°o]\s*transaction|transaction\s*id)\s*[:\-]?\s*([A-Za-z0-9]{5,20})/i);
  return m ? m[1] : null;
}

function detectNetwork(text) {
  if (/airtel/i.test(text)) return 'airtel_money';
  if (/moov/i.test(text)) return 'moov_money';
  return null;
}

function parseReceiptText(text) {
  return {
    amount: extractAmount(text),
    network: detectNetwork(text),
    phone: extractPhone(text),
    reference: extractReference(text),
  };
}

let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('fra', 1, {
      langPath: path.join(__dirname, 'tessdata'),
      gzip: false,
      cachePath: path.join(__dirname, 'tessdata'),
    });
  }
  return workerPromise;
}

async function preprocess(buffer) {
  // Niveaux de gris + normalisation + agrandissement : améliore la lecture par Tesseract
  // sur des captures d'écran de téléphone (souvent petites/compressées).
  return sharp(buffer)
    .resize({ width: 1200, withoutEnlargement: false })
    .grayscale()
    .normalize()
    .sharpen()
    .toBuffer();
}

async function processProof(escrowId) {
  const { data: escrow, error: escrowErr } = await supabase
    .from('escrows')
    .select('id, buyer_id, amount, currency, payment_network, preferred_payment_network, payment_proof_url')
    .eq('id', escrowId)
    .single();

  if (escrowErr || !escrow) throw new Error(`Transaction introuvable: ${escrowErr?.message}`);
  if (!escrow.payment_proof_url) throw new Error('Aucune preuve associée à cette transaction');

  const { data: fileData, error: dlErr } = await supabase.storage
    .from('payment-proofs')
    .download(escrow.payment_proof_url);
  if (dlErr) throw new Error(`Téléchargement impossible: ${dlErr.message}`);

  const buffer = Buffer.from(await fileData.arrayBuffer());
  const processed = await preprocess(buffer);

  const worker = await getWorker();
  const { data: { text } } = await worker.recognize(processed);

  const { amount: extractedAmount, network: extractedNetwork, phone: extractedPhone, reference: extractedReference } = parseReceiptText(text);

  const mismatches = [];
  if (extractedAmount != null && Math.abs(extractedAmount - Number(escrow.amount)) > 1) {
    mismatches.push({ type: 'amount_mismatch', declared: Number(escrow.amount), detected: extractedAmount });
  }
  if (extractedNetwork && escrow.payment_network && extractedNetwork !== escrow.payment_network) {
    mismatches.push({ type: 'network_mismatch', declared: escrow.payment_network, detected: extractedNetwork });
  }
  if (extractedAmount == null) {
    mismatches.push({ type: 'amount_not_readable' });
  }

  const status = mismatches.some(m => m.type !== 'amount_not_readable')
    ? 'mismatch'
    : (extractedAmount == null ? 'failed' : 'ok');

  await supabase.from('proof_verifications').insert({
    escrow_id: escrowId,
    raw_ocr_text: text,
    extracted_amount: extractedAmount,
    extracted_network: extractedNetwork,
    extracted_recipient: extractedPhone,
    extracted_reference: extractedReference,
    mismatches,
    status,
  });

  const realMismatches = mismatches.filter(m => m.type !== 'amount_not_readable');
  if (realMismatches.length > 0) {
    await supabase.from('fraud_events').insert({
      user_id: escrow.buyer_id,
      deposit_id: null,
      event_type: 'ocr_proof_mismatch',
      severity: realMismatches.some(m => m.type === 'amount_mismatch') ? 'high' : 'medium',
      description: `Incohérence détectée par l'OCR entre la preuve envoyée et les données déclarées (transaction ${escrowId})`,
      evidence: { escrow_id: escrowId, mismatches: realMismatches, ocr_text_excerpt: text.slice(0, 500) },
      status: 'open',
    });
  }
}

app.post('/verify-proof', (req, res) => {
  const auth = req.headers.authorization || '';
  if (!SHARED_SECRET || auth !== `Bearer ${SHARED_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { escrow_id } = req.body || {};
  if (!escrow_id) return res.status(400).json({ error: 'escrow_id requis' });

  // On répond tout de suite pour ne pas bloquer le trigger Postgres qui appelle ce endpoint ;
  // le traitement (téléchargement + OCR) se fait en arrière-plan.
  res.status(202).json({ accepted: true });

  processProof(escrow_id).catch(async (err) => {
    console.error(`Erreur vérification preuve ${escrow_id}:`, err);
    await supabase.from('proof_verifications').insert({
      escrow_id,
      status: 'failed',
      mismatches: [{ type: 'processing_error', detail: String(err.message || err) }],
    });
  });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

if (require.main === module) {
  app.listen(PORT, () => console.log(`gourouss-ocr en écoute sur le port ${PORT}`));
}

module.exports = { parseReceiptText, extractAmount, extractPhone, extractReference, detectNetwork, preprocess };
