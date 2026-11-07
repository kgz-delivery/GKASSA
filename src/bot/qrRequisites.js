const jsQR = require('jsqr');
const QRCode = require('qrcode');
const sharp = require('sharp');

const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 24_000_000;
const CARD_WIDTH = 800;
const CARD_HEIGHT = 1000;
const QR_SIZE = 600;

async function decodeQr(imageBuffer) {
  const { data, info } = await sharp(imageBuffer, { limitInputPixels: MAX_IMAGE_PIXELS })
    .rotate()
    .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  const decoded = jsQR(pixels, info.width, info.height, { inversionAttempts: 'attemptBoth' });
  if (!decoded?.data) throw new Error('QR_NOT_FOUND');
  return decoded.data;
}

function cardSvg() {
  return Buffer.from(`
    <svg width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="#eef1f5"/>
      <rect x="24" y="24" width="752" height="952" rx="30" fill="#ffffff"/>
      <path d="M54 24h692a30 30 0 0 1 30 30v150H24V54a30 30 0 0 1 30-30Z" fill="#10243a"/>
      <rect x="24" y="174" width="752" height="30" fill="#10243a"/>
      <rect x="60" y="70" width="5" height="74" rx="2.5" fill="#d4aa58"/>
      <text x="88" y="104" fill="#ffffff" font-family="Arial, sans-serif" font-size="32" font-weight="700" letter-spacing="2">FLASH KASSA</text>
      <text x="88" y="145" fill="#c9d4e1" font-family="Arial, sans-serif" font-size="20" letter-spacing="3">QR BANK</text>
      <rect x="92" y="238" width="616" height="616" rx="24" fill="#ffffff" stroke="#e4e8ee" stroke-width="2"/>
      <text x="400" y="906" fill="#10243a" text-anchor="middle" font-family="Arial, sans-serif" font-size="24" font-weight="700" letter-spacing="1">ОТСКАНИРУЙТЕ ДЛЯ ОПЛАТЫ</text>
      <text x="400" y="943" fill="#718096" text-anchor="middle" font-family="Arial, sans-serif" font-size="17">Откройте приложение вашего банка</text>
    </svg>
  `);
}

async function makeStyledQr(payload) {
  const qrBuffer = await QRCode.toBuffer(payload, {
    type: 'png',
    errorCorrectionLevel: 'H',
    margin: 4,
    width: QR_SIZE,
    color: { dark: '#10243a', light: '#ffffffff' },
  });

  const qrRaw = await sharp(qrBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const verified = jsQR(
    new Uint8ClampedArray(qrRaw.data.buffer, qrRaw.data.byteOffset, qrRaw.data.byteLength),
    qrRaw.info.width,
    qrRaw.info.height,
    { inversionAttempts: 'dontInvert' }
  );
  if (!verified || verified.data !== payload) throw new Error('QR_VERIFY_FAILED');

  return sharp(cardSvg())
    .composite([{ input: qrBuffer, left: (CARD_WIDTH - QR_SIZE) / 2, top: 246 }])
    .png()
    .toBuffer();
}

function extractPaymentLinkFragment(decodedPayload) {
  const hashIndex = String(decodedPayload).indexOf('#');
  if (hashIndex < 0 || hashIndex === String(decodedPayload).length - 1) {
    throw new Error('QR_LINK_FRAGMENT_NOT_FOUND');
  }
  // Keep the original fragment byte-for-byte, including escapes such as %20.
  return String(decodedPayload).slice(hashIndex);
}

async function downloadTelegramPhoto(telegram, fileId) {
  const fileUrl = await telegram.getFileLink(fileId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let response;
  try {
    response = await fetch(fileUrl, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error('QR_DOWNLOAD_FAILED');

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_SOURCE_BYTES) throw new Error('QR_IMAGE_TOO_LARGE');
  const source = Buffer.from(await response.arrayBuffer());
  if (source.length > MAX_SOURCE_BYTES) throw new Error('QR_IMAGE_TOO_LARGE');
  return source;
}

async function readPaymentLinkFragmentFromTelegramPhoto(telegram, fileId) {
  const source = await downloadTelegramPhoto(telegram, fileId);
  return extractPaymentLinkFragment(await decodeQr(source));
}

async function createStyledQrFromTelegramPhoto(telegram, fileId) {
  const source = await downloadTelegramPhoto(telegram, fileId);
  const payload = await decodeQr(source);
  const paymentLinkFragment = extractPaymentLinkFragment(payload);
  return {
    image: await makeStyledQr(payload),
    paymentLinkFragment,
  };
}

module.exports = {
  createStyledQrFromTelegramPhoto,
  readPaymentLinkFragmentFromTelegramPhoto,
};
