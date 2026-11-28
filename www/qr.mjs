// QR codes for links to pages.

import qrcode from "qrcode-generator";

const QUIET = 4; // modules of white around the code, which scanners need

/**
 * The QR code for `text`: its width in modules (quiet zone included) and a
 * test for which of them are dark.
 */
function modules(text) {
  // As much error correction as still fits; a long link leaves room for little.
  for (const level of ["M", "L"]) {
    try {
      const code = qrcode(0, level);
      code.addData(text, "Byte");
      code.make();
      const count = code.getModuleCount();
      return {
        size: count + 2 * QUIET,
        dark: (x, y) => x >= QUIET && y >= QUIET && x < count + QUIET && y < count + QUIET && code.isDark(y - QUIET, x - QUIET),
      };
    } catch {
      // too long for this level
    }
  }
  throw new Error("too long for a QR code");
}

/** The code as an SVG picture: black on white, sharp at any size. */
export function qrSvg(text) {
  const { size, dark } = modules(text);
  let path = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!dark(x, y)) continue;
      // one rectangle for each run of dark modules in a row
      let end = x;
      while (dark(end + 1, y)) end++;
      path += `M${x} ${y}h${end - x + 1}v1h-${end - x + 1}z`;
      x = end;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * 8}" height="${size * 8}" shape-rendering="crispEdges"><path fill="#fff" d="M0 0h${size}v${size}H0z"/><path d="${path}"/></svg>`;
}

/** The code as a PNG picture, about `pixels` wide, for where SVG is not taken. */
export function qrPng(text, pixels = 1024) {
  const { size, dark } = modules(text);
  const scale = Math.max(1, Math.round(pixels / size));
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size * scale;
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (dark(x, y)) context.fillRect(x * scale, y * scale, scale, scale);
    }
  }
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no picture"))), "image/png"));
}
