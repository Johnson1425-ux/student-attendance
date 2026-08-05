import PDFDocument from 'pdfkit';

/**
 * PDF report rendering with PDFKit.
 *
 * PDFKit is used instead of a headless browser deliberately: the backend runs
 * on a small Render instance (PRD §9) where a Chromium process would not fit in
 * the memory budget, and the reports here are plain tabular documents.
 */

const PAGE_MARGIN = 40;
const COLORS = {
  text: '#1f2933',
  muted: '#6b7280',
  rule: '#d8dee9',
  headerBg: '#eef2f7',
  zebra: '#f8fafc',
  accent: '#1d4ed8',
};

const STATUS_COLORS = {
  present: '#047857',
  late: '#b45309',
  absent: '#b91c1c',
  excused: '#4338ca',
};

/**
 * Render a tabular report to a PDF buffer.
 *
 * @param {object} options
 * @param {string} options.title            Main heading
 * @param {string} [options.subtitle]       Secondary heading (date range, class)
 * @param {string} [options.schoolName]
 * @param {Array<{label:string,value:string}>} [options.summary]  Key figures box
 * @param {Array<{key:string,label:string,width:number,align?:string,map?:Function}>} options.columns
 * @param {Array<object>} options.rows
 * @param {string} [options.footerNote]
 * @param {'portrait'|'landscape'} [options.orientation]
 * @returns {Promise<Buffer>}
 */
export function renderTablePdf({
  title,
  subtitle,
  schoolName,
  summary = [],
  columns,
  rows,
  footerNote,
  orientation = 'portrait',
  generatedAt = new Date(),
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: orientation,
      margin: PAGE_MARGIN,
      info: { Title: title, Author: schoolName ?? 'Student Attendance System' },
    });

    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const contentWidth = doc.page.width - PAGE_MARGIN * 2;
    const totalWeight = columns.reduce((sum, c) => sum + (c.width ?? 1), 0);
    const columnWidths = columns.map((c) => ((c.width ?? 1) / totalWeight) * contentWidth);

    // ---- Header -----------------------------------------------------------
    if (schoolName) {
      doc.fillColor(COLORS.muted).fontSize(9).font('Helvetica').text(schoolName.toUpperCase(), {
        characterSpacing: 1,
      });
      doc.moveDown(0.2);
    }
    doc.fillColor(COLORS.text).fontSize(17).font('Helvetica-Bold').text(title);
    if (subtitle) {
      doc.moveDown(0.15);
      doc.fillColor(COLORS.muted).fontSize(10).font('Helvetica').text(subtitle);
    }
    doc.moveDown(0.5);
    doc
      .strokeColor(COLORS.accent)
      .lineWidth(1.5)
      .moveTo(PAGE_MARGIN, doc.y)
      .lineTo(doc.page.width - PAGE_MARGIN, doc.y)
      .stroke();
    doc.moveDown(0.8);

    // ---- Summary tiles ----------------------------------------------------
    if (summary.length) {
      const tileWidth = contentWidth / summary.length;
      const tileTop = doc.y;
      summary.forEach((item, i) => {
        const x = PAGE_MARGIN + i * tileWidth;
        doc.fillColor(COLORS.muted).fontSize(8).font('Helvetica').text(item.label.toUpperCase(), x, tileTop, {
          width: tileWidth - 8,
          characterSpacing: 0.6,
        });
        doc
          .fillColor(COLORS.text)
          .fontSize(15)
          .font('Helvetica-Bold')
          .text(String(item.value), x, tileTop + 12, { width: tileWidth - 8 });
      });
      doc.y = tileTop + 36;
      doc.x = PAGE_MARGIN;
      doc.moveDown(0.4);
    }

    // ---- Table ------------------------------------------------------------
    const rowHeight = 18;
    const headerHeight = 20;

    const drawHeader = () => {
      const y = doc.y;
      doc.rect(PAGE_MARGIN, y, contentWidth, headerHeight).fill(COLORS.headerBg);
      let x = PAGE_MARGIN;
      columns.forEach((col, i) => {
        doc
          .fillColor(COLORS.text)
          .fontSize(8.5)
          .font('Helvetica-Bold')
          .text(col.label.toUpperCase(), x + 5, y + 6, {
            width: columnWidths[i] - 10,
            align: col.align ?? 'left',
            lineBreak: false,
          });
        x += columnWidths[i];
      });
      doc.y = y + headerHeight;
    };

    const bottomLimit = doc.page.height - PAGE_MARGIN - 26;

    drawHeader();

    if (rows.length === 0) {
      doc
        .fillColor(COLORS.muted)
        .fontSize(10)
        .font('Helvetica-Oblique')
        .text('No records for the selected filters.', PAGE_MARGIN + 5, doc.y + 8);
      doc.y += 26;
    }

    rows.forEach((row, index) => {
      if (doc.y + rowHeight > bottomLimit) {
        doc.addPage();
        drawHeader();
      }
      const y = doc.y;
      if (index % 2 === 1) doc.rect(PAGE_MARGIN, y, contentWidth, rowHeight).fill(COLORS.zebra);

      let x = PAGE_MARGIN;
      columns.forEach((col, i) => {
        const raw = col.map ? col.map(row) : row[col.key];
        const value = raw === null || raw === undefined ? '—' : String(raw);
        const statusColor = col.colorByStatus ? STATUS_COLORS[String(raw).toLowerCase()] : null;
        doc
          .fillColor(statusColor ?? COLORS.text)
          .fontSize(8.5)
          .font(statusColor ? 'Helvetica-Bold' : 'Helvetica')
          .text(value, x + 5, y + 5, {
            width: columnWidths[i] - 10,
            align: col.align ?? 'left',
            lineBreak: false,
            ellipsis: true,
          });
        x += columnWidths[i];
      });

      doc
        .strokeColor(COLORS.rule)
        .lineWidth(0.4)
        .moveTo(PAGE_MARGIN, y + rowHeight)
        .lineTo(doc.page.width - PAGE_MARGIN, y + rowHeight)
        .stroke();
      doc.y = y + rowHeight;
    });

    // ---- Footer on every page --------------------------------------------
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      const footerY = doc.page.height - PAGE_MARGIN + 4;
      doc
        .fillColor(COLORS.muted)
        .fontSize(7.5)
        .font('Helvetica')
        .text(
          `${footerNote ?? ''}${footerNote ? '  ·  ' : ''}Generated ${generatedAt.toISOString().replace('T', ' ').slice(0, 16)} UTC`,
          PAGE_MARGIN,
          footerY,
          { width: contentWidth / 2, lineBreak: false },
        );
      doc.text(`Page ${i - range.start + 1} of ${range.count}`, PAGE_MARGIN + contentWidth / 2, footerY, {
        width: contentWidth / 2,
        align: 'right',
        lineBreak: false,
      });
    }

    doc.end();
  });
}

export function pdfFilename(parts) {
  const slug = parts
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'report'}.pdf`;
}
