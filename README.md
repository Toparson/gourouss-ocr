# gourouss-ocr

Service de vérification OCR des preuves de paiement (captures d'écran Airtel Money / Moov Money) pour Gourouss.

Utilise [tesseract.js](https://github.com/naptha/tesseract.js) (Tesseract compilé en WebAssembly) — 100% auto-hébergé,
aucune dépendance à un service OCR payant. Les données d'entraînement français (`tessdata/fra.traineddata`) sont
embarquées dans le repo pour éviter tout appel réseau externe au runtime.

## ⚠️ État du parsing (important)

Les fonctions d'extraction (`extractAmount`, `extractPhone`, `extractReference`, `detectNetwork` dans `server.js`)
sont **provisoires** : écrites sans avoir vu de vrai reçu Airtel Money / Moov Money, sur la base de formats
génériques de reçus mobile money en FCFA. Elles ont été validées uniquement sur une image de test synthétique
(texte généré, pas une vraie capture). **À calibrer avec de vrais screenshots avant mise en prod.**

## Fonctionnement

1. Le buyer soumet une preuve de paiement dans l'app → `submit_payment_proof` RPC met à jour `escrows`.
2. Un trigger Postgres (webhook via `pg_net`) appelle `POST /verify-proof` avec `{ escrow_id }`.
3. Le service télécharge l'image depuis le bucket privé `payment-proofs`, la prétraite (niveaux de gris,
   normalisation, agrandissement), lance l'OCR, puis extrait montant/réseau/numéro/référence.
4. Résultat écrit dans `proof_verifications`. Si incohérence détectée (montant ou réseau différent de ce qui
   est déclaré), un événement est aussi créé dans `fraud_events`.

## Variables d'environnement requises

| Variable | Description |
|---|---|
| `SUPABASE_URL` | URL du projet Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Clé service_role (bypass RLS) — **secrète**, jamais exposée côté client |
| `WEBHOOK_SECRET` | Secret partagé pour authentifier les appels entrants du trigger Postgres |
| `PORT` | Port d'écoute (fourni automatiquement par Render) |

## Endpoints

- `POST /verify-proof` — `Authorization: Bearer <WEBHOOK_SECRET>`, body `{ "escrow_id": "..." }`
- `GET /health` — ping
