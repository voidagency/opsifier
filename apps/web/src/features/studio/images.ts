/** The longest side of an image sent to the agent. The model reads a screenshot as well at this size. */
const MAX_SIDE = 1600;
/** Under the panel's request size limit with a few images and the text around them. */
const MAX_DATA_URL_CHARS = 240_000;

async function decode(file: Blob): Promise<ImageBitmap> {
  return createImageBitmap(file);
}

function draw(bitmap: ImageBitmap, scale: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("This browser cannot resize images.");
  }
  // A transparent screenshot would turn black as a JPEG.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Turns a pasted or chosen image into a JPEG data URL small enough to send: scaled down to
 * {@link MAX_SIDE}, then smaller and lighter until it fits.
 */
export async function imageToDataUrl(file: Blob): Promise<string> {
  const bitmap = await decode(file);
  try {
    let scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    let quality = 0.85;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const url = draw(bitmap, scale).toDataURL("image/jpeg", quality);
      if (url.length <= MAX_DATA_URL_CHARS) {
        return url;
      }
      scale *= 0.8;
      quality = Math.max(0.6, quality - 0.08);
    }
    throw new Error("This image is too large to send.");
  } finally {
    bitmap.close();
  }
}
