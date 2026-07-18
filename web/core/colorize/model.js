// core/colorize/model.js — shared constants for the on-device colorizer model,
// imported by BOTH the worker (inference) and the main-thread engine (so the
// settings UI can check/download the model without duplicating the URL).
//
// Model: manga-colorization-v2 (qweasdd) — a GAN trained on MANGA/anime art, not
// photos. This is the model the browser manga colorizers (e.g. Chromanga) ship,
// and it's the right call here: the 2025 SOTA line-art colorizers (MangaNinja,
// ControlNet/FLUX LoRAs) are multi-GB diffusion models that need a colour
// REFERENCE image and many sampling steps — they can't run in a browser tab.
// DDColor was tried and rejected: it's photo-trained, so manga came out wrong.
// Pinned to a COMMIT SHA, not /main/ — a floating branch ref lets the repo
// owner (or anyone who compromises the account) swap the weights out from under
// every user, and the bytes land in a cache deliberately exempt from service
// worker cleanup, so a bad copy would be sticky across deploys.
export const MODEL_URL = 'https://huggingface.co/Faridzar/manga-colorization-v2-onnx/resolve/5515e06d31b08ffd107af686cba5e98e95e8d4cf/manga-colorize-fp16.onnx';
export const MODEL_BYTES = 61_650_260; // ~62 MB
// Hugging Face's LFS oid, which is the file's SHA-256. Checked before the bytes
// reach the ONNX parser (a native wasm protobuf reader).
export const MODEL_SHA256 = '39660d0047ea6f1a0ddee6aa89054997f95ea566f4d56ff762f66dbcf1a1a7ef';
export const MODEL_CACHE = 'nyora-tl-models'; // shared persistent bucket (survives SW upgrades)
