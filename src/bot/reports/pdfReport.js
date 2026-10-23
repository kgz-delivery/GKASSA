const PDFDocument = require('pdfkit');
const path = require('path');
const { getSiteLabel, providerLabel } = require('../../providers');

const FONT_DIR = path.resolve(__dirname, '../../../assets/fonts');
const COLORS = {
  navy: '#102A43',
  blue: '#2563EB',
  pale: '#EFF6FF',
  ink: '#243B53',
  muted: '#627D98',
  line: '#D9E2EC',
  row: '#F7FAFC',
  white: '#FFFFFF',
};

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(String(value).replace(' ', 'T') + (String(value).endsWith('Z') ? '' : 'Z'));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Bishkek', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function bookmakerId(row) {
  if (row.type === 'topup') return row.payment_id || '—';
  return row.withdraw_details?.match(/ID букмекера:\s*([^\r\n]+)/i)?.[1]?.trim() || '—';
}

function bookmakerName(row) {
  if (row.site) return getSiteLabel(row.site);
  if (row.type === 'topup') return providerLabel(row.provider);
  return 'Букмекер не указан';
}

function formatAmount(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return 'Не указана';
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value)} сом`;
}

function makeBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

function drawPageHeader(doc, title, generatedAt, page, pages) {
  const { left, right, top } = doc.page.margins;
  const width = doc.page.width - left - right;
  doc.rect(0, 0, doc.page.width, 120).fill(COLORS.navy);
  doc.fillColor(COLORS.white).font('Lato-Bold').fontSize(17).text('FLASH KASSA', left, 20);
  doc.fillColor('#BFDBFE').font('Lato').fontSize(8).text('ФИНАНСОВЫЙ ОТЧЁТ', left, 43);
  doc.fillColor(COLORS.white).font('Lato-Bold').fontSize(15).text(title, left, 61, { width: width * 0.72 });
  doc.fillColor('#D9EAF7').font('Lato').fontSize(9)
    .text(`Сформирован: ${generatedAt}`, left, 88, { width: width * 0.72 });
  doc.fillColor('#BFDBFE').font('Lato').fontSize(9)
    .text(`Страница ${page} из ${pages}`, left + width * 0.76, 88, { width: width * 0.24, align: 'right' });
}

function drawSummary(doc, rows, y, isWithdraw) {
  const left = doc.page.margins.left;
  const gap = 12;
  const cardWidth = (doc.page.width - doc.page.margins.left - doc.page.margins.right - gap * 2) / 3;
  const amountRows = rows.filter((row) => Number(row.amount) > 0);
  const total = amountRows.reduce((sum, row) => sum + Number(row.amount), 0);
  const cards = [
    ['УСПЕШНЫХ ОПЕРАЦИЙ', String(rows.length)],
    [isWithdraw ? 'СУММА ИЗВЕСТНЫХ ВЫПЛАТ' : 'ОБЩАЯ СУММА', `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(total)} сом`],
    ['СУММА НЕ УКАЗАНА', String(rows.length - amountRows.length)],
  ];
  cards.forEach(([label, value], i) => {
    const x = left + i * (cardWidth + gap);
    doc.roundedRect(x, y, cardWidth, 54, 8).fill(COLORS.pale);
    doc.fillColor(COLORS.muted).font('Lato-Bold').fontSize(8).text(label, x + 12, y + 10, { width: cardWidth - 24 });
    doc.fillColor(COLORS.navy).font('Lato-Bold').fontSize(14).text(value, x + 12, y + 27, { width: cardWidth - 24 });
  });
  return { y: y + 70, total, unknown: rows.length - amountRows.length };
}

function drawTableHeader(doc, y, columns) {
  const x = doc.page.margins.left;
  const height = 29;
  doc.roundedRect(x, y, columns.reduce((sum, col) => sum + col.width, 0), height, 4).fill(COLORS.blue);
  let cx = x;
  for (const column of columns) {
    doc.fillColor(COLORS.white).font('Lato-Bold').fontSize(8)
      .text(column.title, cx + 8, y + 9, { width: column.width - 16, lineBreak: false });
    cx += column.width;
  }
  return y + height;
}

function drawRow(doc, row, y, columns, index) {
  const cells = [row.transaction_id || '—', formatDate(row.confirmed_at || row.created_at), bookmakerName(row), bookmakerId(row), formatAmount(row.amount)];
  const padX = 8;
  const padY = 8;
  const fontSize = 8.5;
  const heights = cells.map((cell, i) => doc.font('Lato').fontSize(fontSize).heightOfString(String(cell), { width: columns[i].width - padX * 2 }));
  const height = Math.max(30, Math.max(...heights) + padY * 2);
  if (index % 2 === 0) doc.rect(doc.page.margins.left, y, columns.reduce((sum, col) => sum + col.width, 0), height).fill(COLORS.row);
  let x = doc.page.margins.left;
  cells.forEach((cell, i) => {
    doc.fillColor(COLORS.ink).font('Lato').fontSize(fontSize)
      .text(String(cell), x + padX, y + padY, { width: columns[i].width - padX * 2, height: height - padY });
    x += columns[i].width;
  });
  doc.moveTo(doc.page.margins.left, y + height).lineTo(doc.page.width - doc.page.margins.right, y + height).lineWidth(0.5).strokeColor(COLORS.line).stroke();
  return y + height;
}

async function createTransactionReport({ type, rows }) {
  const isWithdraw = type === 'withdraw';
  const title = isWithdraw ? 'Успешные выводы' : 'Успешные пополнения';
  const generatedAt = formatDate(new Date().toISOString());
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margins: { top: 140, bottom: 44, left: 32, right: 32 }, bufferPages: true, info: { Title: title, Author: 'FLASH KASSA' } });
  doc.registerFont('Lato', path.join(FONT_DIR, 'Lato-Regular.ttf'));
  doc.registerFont('Lato-Bold', path.join(FONT_DIR, 'Lato-Bold.ttf'));

  const columns = [
    { title: 'КОД ТРАНЗАКЦИИ', width: 140 },
    { title: 'ДАТА И ВРЕМЯ', width: 125 },
    { title: 'БУКМЕКЕР', width: 132 },
    { title: 'ID БУКМЕКЕРА', width: 170 },
    { title: 'СУММА', width: 120 },
  ];
  const tableWidth = columns.reduce((sum, col) => sum + col.width, 0);
  const available = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const scale = available / tableWidth;
  columns.forEach((column) => { column.width *= scale; });

  let y = 140;
  drawSummary(doc, rows, y, isWithdraw);
  y += 70;
  y = drawTableHeader(doc, y, columns);
  if (rows.length === 0) {
    doc.fillColor(COLORS.muted).font('Lato').fontSize(11).text('За выбранный период успешных операций нет.', doc.page.margins.left, y + 24);
  } else {
    rows.forEach((row, index) => {
      doc.font('Lato').fontSize(8.5);
      const rowHeight = Math.max(30, ...[
        row.transaction_id || '—', formatDate(row.confirmed_at || row.created_at), bookmakerName(row), bookmakerId(row), formatAmount(row.amount),
      ].map((cell, i) => doc.heightOfString(String(cell), { width: columns[i].width - 16 })) + 16);
      if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        y = 140;
        y = drawTableHeader(doc, y, columns);
      }
      y = drawRow(doc, row, y, columns, index);
    });
  }

  const rangeDates = rows.map((row) => row.confirmed_at || row.created_at).filter(Boolean).sort();
  const range = rangeDates.length ? `${formatDate(rangeDates[0])} — ${formatDate(rangeDates[rangeDates.length - 1])}` : 'нет данных';
  const rangeInfo = doc.bufferedPageRange();
  for (let i = 0; i < rangeInfo.count; i += 1) {
    doc.switchToPage(rangeInfo.start + i);
    drawPageHeader(doc, title, generatedAt, i + 1, rangeInfo.count);
    doc.fillColor(COLORS.muted).font('Lato').fontSize(8)
      .text(`Период: ${range} · Только подтверждённые операции`, doc.page.margins.left, doc.page.height - 27, { width: available });
  }
  return makeBuffer(doc);
}

module.exports = { createTransactionReport };
