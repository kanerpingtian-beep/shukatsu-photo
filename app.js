const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const canvas = $("#previewCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const sourceCanvas = document.createElement("canvas");
const sourceCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });
const processedCanvas = document.createElement("canvas");
const processedCtx = processedCanvas.getContext("2d", { willReadFrequently: true });
const smoothCanvas = document.createElement("canvas");
const smoothCtx = smoothCanvas.getContext("2d");
const segmentationInputCanvas = document.createElement("canvas");
const segmentationInputCtx = segmentationInputCanvas.getContext("2d");
const personMaskCanvas = document.createElement("canvas");
const personMaskCtx = personMaskCanvas.getContext("2d");

const state = {
  image: null,
  preset: "es",
  format: "jpeg",
  background: "#f8f8f6",
  removeBackground: true,
  brightness: 104,
  contrast: 102,
  smooth: 2,
  warmth: 1,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  dragging: false,
  lastPointer: null,
  stream: null,
  facingMode: "user",
  renderQueued: false,
  maskStatus: "idle",
  maskRevision: 0,
  showOriginal: false,
  timerSeconds: 0,
  countdownHandle: null,
  sizeRevision: 0
};

const MIN_SCALE = 0.6;
const MAX_SCALE = 2.5;

const MEDIAPIPE_VERSION = "0.10.35";
const MEDIAPIPE_MODULE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`;
const MEDIAPIPE_WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const PERSON_SEGMENTATION_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";
let personSegmenterPromise = null;

// 履歴書: 900×1200px / 762dpi を埋め込むと物理サイズがちょうど 30×40mm になる
// L判シート: 89×127mm @300dpi (横) = 1500×1051px、30×40mm(354×472px) を8枚面付け
const presets = {
  es: { width: 1200, height: 1600, dpi: null, type: "single", describe: () => "1200 × 1600 px・Web ES用" },
  resume: { width: 900, height: 1200, dpi: 762, type: "single", describe: () => "900 × 1200 px・印刷時 30 × 40 mm" },
  sheet: {
    width: 1500, height: 1051, dpi: 300, type: "sheet",
    tile: { width: 354, height: 472, cols: 4, rows: 2, gap: 8 },
    describe: () => "L判 1500 × 1051 px・30×40mm を8枚面付け"
  }
};

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function updateRangeFill(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const value = Number(input.value);
  input.style.setProperty("--value", `${((value - min) / (max - min)) * 100}%`);
}

$$('input[type="range"]').forEach(updateRangeFill);

function signed(value, baseline = 0) {
  const delta = Number(value) - baseline;
  return delta > 0 ? `+${delta}` : `${delta}`;
}

function updateExportText(sizeText = "") {
  const preset = presets[state.preset];
  const suffix = state.preset === "sheet" ? "-print" : "";
  $("#exportName").textContent = `shukatsu-photo${suffix}.${state.format === "jpeg" ? "jpg" : "png"}`;
  $("#exportDetails").textContent = `${state.format.toUpperCase()}・${preset.describe()}${sizeText ? `・${sizeText}` : ""}`;
}

function setBackgroundStatus(status) {
  state.maskStatus = status;
  const button = $("#autoBackgroundButton");
  if (status === "loading") {
    button.textContent = personSegmenterPromise ? "AI認識中…" : "AIモデル読込中…（初回のみ）";
    button.disabled = true;
    $("#downloadButton").disabled = true;
  } else if (status === "ready") {
    button.textContent = "AI補正済み";
    button.disabled = false;
    $("#downloadButton").disabled = !state.image;
  } else if (status === "error") {
    button.textContent = "もう一度試す";
    button.disabled = false;
    $("#downloadButton").disabled = !state.image;
  } else {
    button.textContent = "AIで背景を整える";
    button.disabled = false;
  }
}

async function getPersonSegmenter() {
  if (personSegmenterPromise) return personSegmenterPromise;

  personSegmenterPromise = (async () => {
    const { FilesetResolver, ImageSegmenter } = await import(MEDIAPIPE_MODULE_URL);
    const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_URL);
    return ImageSegmenter.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: PERSON_SEGMENTATION_MODEL_URL
      },
      runningMode: "IMAGE",
      outputCategoryMask: true,
      outputConfidenceMasks: true
    });
  })();

  try {
    return await personSegmenterPromise;
  } catch (error) {
    personSegmenterPromise = null;
    throw error;
  }
}

function smoothStep(min, max, value) {
  const x = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return x * x * (3 - 2 * x);
}

function findMainPersonRegion(confidenceData, width, height, threshold = .34) {
  const labels = new Int32Array(width * height);
  labels.fill(-1);
  const queue = new Int32Array(width * height);
  let componentId = 0;
  let bestComponent = -1;
  let bestScore = 0;

  for (let start = 0; start < confidenceData.length; start++) {
    if (labels[start] !== -1 || confidenceData[start] < threshold) continue;

    let head = 0;
    let tail = 0;
    let size = 0;
    let centralPixels = 0;
    queue[tail++] = start;
    labels[start] = componentId;

    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      size++;

      const normalizedX = (x / width - .5) / .36;
      const normalizedY = (y / height - .48) / .48;
      if (normalizedX * normalizedX + normalizedY * normalizedY < 1) centralPixels++;

      const neighbors = [
        x > 0 ? index - 1 : -1,
        x < width - 1 ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y < height - 1 ? index + width : -1
      ];

      for (const neighbor of neighbors) {
        if (
          neighbor >= 0 &&
          labels[neighbor] === -1 &&
          confidenceData[neighbor] >= threshold
        ) {
          labels[neighbor] = componentId;
          queue[tail++] = neighbor;
        }
      }
    }

    const score = size + centralPixels * 3;
    if (score > bestScore) {
      bestScore = score;
      bestComponent = componentId;
    }
    componentId++;
  }

  const region = new Uint8Array(width * height);
  if (bestComponent < 0) return region;
  for (let index = 0; index < labels.length; index++) {
    if (labels[index] === bestComponent) region[index] = 1;
  }
  return region;
}

// 分離マスクの収縮（erode）。半透明の境界帯には元背景の色が混ざっており、
// そのまま白背景に合成すると輪郭に色付きのフリンジが出る。
// マスクを内側に数px縮めることで、混色した境界ピクセルを捨てる。
function erodeAlpha(alpha, width, height, radius) {
  const tmp = new Uint8ClampedArray(alpha.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let min = 255;
      const from = Math.max(0, x - radius);
      const to = Math.min(width - 1, x + radius);
      for (let xx = from; xx <= to; xx++) {
        const v = alpha[row + xx];
        if (v < min) min = v;
      }
      tmp[row + x] = min;
    }
  }
  const out = new Uint8ClampedArray(alpha.length);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let min = 255;
      const from = Math.max(0, y - radius);
      const to = Math.min(height - 1, y + radius);
      for (let yy = from; yy <= to; yy++) {
        const v = tmp[yy * width + x];
        if (v < min) min = v;
      }
      out[y * width + x] = min;
    }
  }
  return out;
}

// 収縮後の硬い輪郭をなだらかに戻すフェザリング（分離ボックスブラー）
function featherAlpha(alpha, width, height, radius) {
  const window = radius * 2 + 1;
  const tmp = new Float32Array(alpha.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += alpha[row + Math.min(width - 1, Math.max(0, x))];
    for (let x = 0; x < width; x++) {
      tmp[row + x] = sum / window;
      const addX = Math.min(width - 1, x + radius + 1);
      const subX = Math.max(0, x - radius);
      sum += alpha[row + addX] - alpha[row + subX];
    }
  }
  const out = new Uint8ClampedArray(alpha.length);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += tmp[Math.min(height - 1, Math.max(0, y)) * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = Math.round(sum / window);
      const addY = Math.min(height - 1, y + radius + 1);
      const subY = Math.max(0, y - radius);
      sum += tmp[addY * width + x] - tmp[subY * width + x];
    }
  }
  return out;
}

function closeSegmentationResult(result) {
  result.categoryMask?.close();
  result.confidenceMasks?.forEach(mask => mask.close());
}

async function createPersonMask() {
  if (!state.image || state.maskStatus === "loading") return;

  const revision = ++state.maskRevision;
  setBackgroundStatus("loading");
  showToast("AIが人物の輪郭を認識しています…");

  try {
    const maxInputEdge = 1024;
    const inputScale = Math.min(1, maxInputEdge / Math.max(sourceCanvas.width, sourceCanvas.height));
    segmentationInputCanvas.width = Math.max(1, Math.round(sourceCanvas.width * inputScale));
    segmentationInputCanvas.height = Math.max(1, Math.round(sourceCanvas.height * inputScale));
    segmentationInputCtx.clearRect(0, 0, segmentationInputCanvas.width, segmentationInputCanvas.height);
    segmentationInputCtx.imageSmoothingEnabled = true;
    segmentationInputCtx.imageSmoothingQuality = "high";
    segmentationInputCtx.drawImage(
      sourceCanvas,
      0,
      0,
      segmentationInputCanvas.width,
      segmentationInputCanvas.height
    );

    const segmenter = await getPersonSegmenter();
    const result = await new Promise((resolve, reject) => {
      try {
        segmenter.segment(segmentationInputCanvas, resolve);
      } catch (error) {
        reject(error);
      }
    });

    if (revision !== state.maskRevision) {
      closeSegmentationResult(result);
      return;
    }

    const confidenceMask = result.confidenceMasks?.length
      ? result.confidenceMasks[Math.min(1, result.confidenceMasks.length - 1)]
      : null;
    const categoryMask = result.categoryMask || null;
    const mask = confidenceMask || categoryMask;
    if (!mask) throw new Error("人物マスクを取得できませんでした");

    const width = mask.width;
    const height = mask.height;
    const confidenceData = confidenceMask ? new Float32Array(confidenceMask.getAsFloat32Array()) : null;
    const categoryData = categoryMask ? new Uint8Array(categoryMask.getAsUint8Array()) : null;
    const mainPersonRegion = confidenceData
      ? findMainPersonRegion(confidenceData, width, height)
      : null;

    // 1. 生のアルファマップを作る（しきい値を下げて髪の毛先まで拾う）
    let alpha = new Uint8ClampedArray(width * height);
    for (let index = 0; index < width * height; index++) {
      if (confidenceData) {
        const isPerson = mainPersonRegion ? mainPersonRegion[index] === 1 : confidenceData[index] >= .5;
        alpha[index] = isPerson ? Math.round(smoothStep(.34, .62, confidenceData[index]) * 255) : 0;
      } else {
        alpha[index] = categoryData[index] === 1 ? 255 : 0;
      }
    }

    // 2. 収縮 → 3. フェザリング（フリンジ除去の要）
    const edgeRadius = Math.max(1, Math.round(Math.max(width, height) / 512));
    alpha = erodeAlpha(alpha, width, height, edgeRadius);
    alpha = featherAlpha(alpha, width, height, edgeRadius);

    const imageData = personMaskCtx.createImageData(width, height);
    for (let index = 0; index < width * height; index++) {
      const pixel = index * 4;
      imageData.data[pixel] = 255;
      imageData.data[pixel + 1] = 255;
      imageData.data[pixel + 2] = 255;
      imageData.data[pixel + 3] = alpha[index];
    }

    personMaskCanvas.width = width;
    personMaskCanvas.height = height;
    personMaskCtx.putImageData(imageData, 0, 0);
    closeSegmentationResult(result);

    setBackgroundStatus("ready");
    scheduleRender();
    showToast("人物を残して背景をきれいに分離しました");
  } catch (error) {
    if (revision !== state.maskRevision) return;
    personMaskCanvas.width = 0;
    personMaskCanvas.height = 0;
    setBackgroundStatus("error");
    scheduleRender();
    showToast("AI背景補正を読み込めませんでした。通信環境を確認して再試行してください");
  }
}

function resetAdjustments(render = true) {
  Object.assign(state, {
    brightness: 104,
    contrast: 102,
    smooth: 2,
    warmth: 1,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    background: "#f8f8f6",
    removeBackground: true
  });

  $("#brightnessSlider").value = 104;
  $("#contrastSlider").value = 102;
  $("#smoothSlider").value = 2;
  $("#warmthSlider").value = 1;
  $("#backgroundToggle").checked = true;
  $("#brightnessValue").textContent = "+4";
  $("#contrastValue").textContent = "+2";
  $("#smoothValue").textContent = "2";
  $("#warmthValue").textContent = "+1";
  $$('input[type="range"]').forEach(updateRangeFill);
  $$(".color-swatch").forEach((button, index) => button.classList.toggle("active", index === 0));
  if (render) scheduleRender();
}

async function loadImageFile(file) {
  if (!file || (file.type && !file.type.startsWith("image/"))) {
    showToast("画像ファイルを選んでください");
    return;
  }
  if (file.size > 25 * 1024 * 1024) {
    showToast("25MB以下の画像を選んでください");
    return;
  }

  showToast("写真を読み込んでいます…");
  const objectUrl = URL.createObjectURL(file);

  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = objectUrl;
    });
    setSourceImage(image);
  } catch (error) {
    showToast("写真を読み込めませんでした。JPEGまたはPNGをお試しください");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function setSourceImage(image) {
  try {
    const originalWidth = image.naturalWidth || image.width;
    const originalHeight = image.naturalHeight || image.height;
    const maxEdge = 2560;
    const maxPixels = 5_000_000;
    const edgeScale = Math.min(1, maxEdge / Math.max(originalWidth, originalHeight));
    const pixelScale = Math.min(1, Math.sqrt(maxPixels / (originalWidth * originalHeight)));
    const sourceScale = Math.min(edgeScale, pixelScale);

    sourceCanvas.width = Math.max(1, Math.round(originalWidth * sourceScale));
    sourceCanvas.height = Math.max(1, Math.round(originalHeight * sourceScale));
    sourceCtx.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
    sourceCtx.imageSmoothingEnabled = true;
    sourceCtx.imageSmoothingQuality = "high";
    sourceCtx.drawImage(image, 0, 0, sourceCanvas.width, sourceCanvas.height);

    state.image = true;
    state.maskRevision++;
    state.scale = 1;
    state.offsetX = 0;
    state.offsetY = 0;
    personMaskCanvas.width = 0;
    personMaskCanvas.height = 0;
    setBackgroundStatus("idle");
    const emptyState = $("#emptyState");
    emptyState.hidden = true;
    emptyState.classList.add("is-hidden");
    $("#cropGuides").hidden = false;
    $("#stageHint").classList.add("active");
    $("#compareButton").hidden = false;
    $("#downloadButton").disabled = false;
    scheduleRender();
    createPersonMask();
    $("#studioSection").scrollIntoView({ behavior: "smooth", block: "start" });
    showToast("写真を読み込みました。位置を整えてください");
  } catch (error) {
    state.image = null;
    showToast("写真の処理に失敗しました。別の写真をお試しください");
  }
}

function getCoverTransform(targetWidth, targetHeight) {
  if (!state.image) return null;
  const imageWidth = sourceCanvas.width;
  const imageHeight = sourceCanvas.height;
  const baseScale = Math.max(targetWidth / imageWidth, targetHeight / imageHeight);
  const scale = baseScale * state.scale;
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;
  const maxOffsetX = Math.max(0, (drawWidth - targetWidth) / 2);
  const maxOffsetY = Math.max(0, (drawHeight - targetHeight) / 2);
  const offsetX = Math.max(-maxOffsetX, Math.min(maxOffsetX, state.offsetX * targetWidth));
  const offsetY = Math.max(-maxOffsetY, Math.min(maxOffsetY, state.offsetY * targetHeight));
  state.offsetX = offsetX / targetWidth;
  state.offsetY = offsetY / targetHeight;
  return {
    x: (targetWidth - drawWidth) / 2 + offsetX,
    y: (targetHeight - drawHeight) / 2 + offsetY,
    width: drawWidth,
    height: drawHeight
  };
}

function applyWarmth(imageData, amount) {
  if (!amount) return imageData;
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.max(0, Math.min(255, data[i] + amount * 1.35));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] - amount * .9));
  }
  return imageData;
}

function renderTo(targetCanvas, width, height, highQuality = false) {
  const targetCtx = targetCanvas.getContext("2d", { willReadFrequently: true });
  targetCanvas.width = width;
  targetCanvas.height = height;
  targetCtx.clearRect(0, 0, width, height);
  targetCtx.fillStyle = state.background === "original" ? "#f8f8f6" : state.background;
  targetCtx.fillRect(0, 0, width, height);

  if (!state.image) return;
  const transform = getCoverTransform(width, height);

  // 長押し比較: 補正なしの元写真をそのまま表示
  if (state.showOriginal) {
    targetCtx.imageSmoothingEnabled = true;
    targetCtx.imageSmoothingQuality = "high";
    targetCtx.drawImage(sourceCanvas, transform.x, transform.y, transform.width, transform.height);
    return;
  }

  processedCanvas.width = width;
  processedCanvas.height = height;
  processedCtx.clearRect(0, 0, width, height);
  processedCtx.imageSmoothingEnabled = true;
  processedCtx.imageSmoothingQuality = "high";
  processedCtx.filter = `brightness(${state.brightness}%) contrast(${state.contrast}%)`;
  processedCtx.drawImage(sourceCanvas, transform.x, transform.y, transform.width, transform.height);
  processedCtx.filter = "none";

  if (state.warmth !== 0) {
    let pixels = processedCtx.getImageData(0, 0, width, height);
    pixels = applyWarmth(pixels, state.warmth);
    processedCtx.putImageData(pixels, 0, 0);
  }

  const maskAvailable = state.maskStatus === "ready" && personMaskCanvas.width > 0;

  // 肌スムージング: 画像全体ではなく人物領域だけにぼかしレイヤーを重ねる。
  // 背景や輪郭のシャープさを保ったまま、肌のノイズだけをなだらかにする。
  if (state.smooth > 0) {
    const radius = state.smooth * .4 * (width / 450);
    smoothCanvas.width = width;
    smoothCanvas.height = height;
    smoothCtx.clearRect(0, 0, width, height);
    smoothCtx.filter = `blur(${radius}px)`;
    smoothCtx.drawImage(processedCanvas, 0, 0);
    smoothCtx.filter = "none";
    if (maskAvailable) {
      smoothCtx.globalCompositeOperation = "destination-in";
      smoothCtx.drawImage(personMaskCanvas, transform.x, transform.y, transform.width, transform.height);
      smoothCtx.globalCompositeOperation = "source-over";
    }
    processedCtx.globalAlpha = .7;
    processedCtx.drawImage(smoothCanvas, 0, 0);
    processedCtx.globalAlpha = 1;
  }

  if (
    state.removeBackground &&
    state.background !== "original" &&
    maskAvailable
  ) {
    processedCtx.save();
    processedCtx.globalCompositeOperation = "destination-in";
    processedCtx.filter = `blur(${Math.max(.4, width / 2400)}px)`;
    processedCtx.drawImage(
      personMaskCanvas,
      transform.x,
      transform.y,
      transform.width,
      transform.height
    );
    processedCtx.restore();
  }

  targetCtx.drawImage(processedCanvas, 0, 0);
}

function renderPreview() {
  state.renderQueued = false;
  const previewWidth = 450;
  const previewHeight = 600;
  renderTo(canvas, previewWidth, previewHeight);
}

function scheduleRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(renderPreview);
  scheduleFileSizeUpdate();
}

// ---- 書き出し ----

function renderExportCanvas() {
  const preset = presets[state.preset];
  const exportCanvas = document.createElement("canvas");

  if (preset.type === "sheet") {
    const photo = document.createElement("canvas");
    renderTo(photo, 900, 1200, true);
    const { tile } = preset;
    exportCanvas.width = preset.width;
    exportCanvas.height = preset.height;
    const sheetCtx = exportCanvas.getContext("2d");
    sheetCtx.fillStyle = "#ffffff";
    sheetCtx.fillRect(0, 0, preset.width, preset.height);
    sheetCtx.imageSmoothingEnabled = true;
    sheetCtx.imageSmoothingQuality = "high";
    const gridWidth = tile.cols * tile.width + (tile.cols - 1) * tile.gap;
    const gridHeight = tile.rows * tile.height + (tile.rows - 1) * tile.gap;
    const originX = Math.round((preset.width - gridWidth) / 2);
    const originY = Math.round((preset.height - gridHeight) / 2);
    sheetCtx.strokeStyle = "#c8c8c8";
    sheetCtx.lineWidth = 1;
    for (let row = 0; row < tile.rows; row++) {
      for (let col = 0; col < tile.cols; col++) {
        const x = originX + col * (tile.width + tile.gap);
        const y = originY + row * (tile.height + tile.gap);
        sheetCtx.drawImage(photo, x, y, tile.width, tile.height);
        sheetCtx.strokeRect(x + .5, y + .5, tile.width - 1, tile.height - 1);
      }
    }
  } else {
    renderTo(exportCanvas, preset.width, preset.height, true);
  }
  return exportCanvas;
}

function createExportBlob() {
  return new Promise(resolve => {
    const exportCanvas = renderExportCanvas();
    const mime = state.format === "png" ? "image/png" : "image/jpeg";
    exportCanvas.toBlob(blob => resolve(blob), mime, .96);
  });
}

// JPEG(JFIF)のAPP0に印刷解像度(dpi)を書き込む。
// これで履歴書プリセットは印刷ソフトでちょうど 30×40mm として扱われる。
function setJpegDensity(buffer, dpi) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length > 18 &&
    bytes[0] === 0xFF && bytes[1] === 0xD8 &&
    bytes[2] === 0xFF && bytes[3] === 0xE0 &&
    bytes[6] === 0x4A && bytes[7] === 0x46 && bytes[8] === 0x49 && bytes[9] === 0x46 && bytes[10] === 0x00
  ) {
    bytes[13] = 1; // units = dots per inch
    bytes[14] = (dpi >> 8) & 0xFF;
    bytes[15] = dpi & 0xFF;
    bytes[16] = (dpi >> 8) & 0xFF;
    bytes[17] = dpi & 0xFF;
  }
  return bytes;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `約${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `約${Math.max(1, Math.round(bytes / 1024))}KB`;
}

// スライダー操作のたびに全画素を書き出すのは重いので、操作が落ち着いてから計測する
let fileSizeTimer = null;
function scheduleFileSizeUpdate() {
  clearTimeout(fileSizeTimer);
  if (!state.image) {
    updateExportText();
    return;
  }
  fileSizeTimer = setTimeout(async () => {
    if (!state.image || state.showOriginal) return;
    const revision = ++state.sizeRevision;
    const blob = await createExportBlob();
    if (!blob || revision !== state.sizeRevision) return;
    updateExportText(formatBytes(blob.size));
  }, 900);
}

$("#uploadButton").addEventListener("click", () => $("#fileInput").click());
$("#fileInput").addEventListener("change", event => {
  loadImageFile(event.target.files[0]);
  event.target.value = "";
});

$("#photoStage").addEventListener("dragover", event => {
  event.preventDefault();
  event.currentTarget.classList.add("dragging-file");
});
$("#photoStage").addEventListener("dragleave", event => event.currentTarget.classList.remove("dragging-file"));
$("#photoStage").addEventListener("drop", event => {
  event.preventDefault();
  event.currentTarget.classList.remove("dragging-file");
  loadImageFile(event.dataTransfer.files[0]);
});

$$(".preset-card").forEach(button => button.addEventListener("click", () => {
  state.preset = button.dataset.preset;
  $$(".preset-card").forEach(item => item.classList.toggle("active", item === button));
  updateExportText();
  scheduleRender();
}));

$$(".color-swatch").forEach(button => button.addEventListener("click", () => {
  state.background = button.dataset.bg;
  $$(".color-swatch").forEach(item => item.classList.toggle("active", item === button));
  $("#backgroundToggle").checked = state.background !== "original";
  state.removeBackground = state.background !== "original";
  if (state.removeBackground && state.image && state.maskStatus !== "ready") createPersonMask();
  scheduleRender();
}));

$("#backgroundToggle").addEventListener("change", event => {
  state.removeBackground = event.target.checked;
  if (state.removeBackground && state.image && state.maskStatus !== "ready") createPersonMask();
  scheduleRender();
});

const sliders = [
  ["brightnessSlider", "brightness", "brightnessValue", 100],
  ["contrastSlider", "contrast", "contrastValue", 100],
  ["smoothSlider", "smooth", "smoothValue", 0],
  ["warmthSlider", "warmth", "warmthValue", 0]
];

for (const [inputId, key, outputId, baseline] of sliders) {
  const input = $(`#${inputId}`);
  input.addEventListener("input", () => {
    state[key] = Number(input.value);
    $(`#${outputId}`).textContent = key === "smooth" ? input.value : signed(input.value, baseline);
    updateRangeFill(input);
    scheduleRender();
  });
}

$("#autoAdjustButton").addEventListener("click", () => {
  state.brightness = 106;
  state.contrast = 103;
  state.smooth = 2;
  state.warmth = 1;
  $("#brightnessSlider").value = 106;
  $("#contrastSlider").value = 103;
  $("#smoothSlider").value = 2;
  $("#warmthSlider").value = 1;
  $("#brightnessValue").textContent = "+6";
  $("#contrastValue").textContent = "+3";
  $("#smoothValue").textContent = "2";
  $("#warmthValue").textContent = "+1";
  $$('input[type="range"]').forEach(updateRangeFill);
  scheduleRender();
  showToast("自然なおすすめ補正を適用しました");
});

$("#autoBackgroundButton").addEventListener("click", () => {
  state.background = "#f8f8f6";
  state.removeBackground = true;
  $("#backgroundToggle").checked = true;
  $$(".color-swatch").forEach((button, index) => button.classList.toggle("active", index === 0));
  if (state.maskStatus === "ready") {
    scheduleRender();
    showToast("AI人物分離で背景を白く整えました");
  } else {
    createPersonMask();
  }
});

$("#resetButton").addEventListener("click", () => {
  resetAdjustments();
  showToast("調整をリセットしました");
});

$$(".format-button").forEach(button => button.addEventListener("click", () => {
  state.format = button.dataset.format;
  $$(".format-button").forEach(item => item.classList.toggle("active", item === button));
  updateExportText();
  scheduleFileSizeUpdate();
}));

$("#downloadButton").addEventListener("click", async () => {
  if (!state.image) return;
  const preset = presets[state.preset];
  const blob = await createExportBlob();
  if (!blob) {
    showToast("書き出しに失敗しました。もう一度お試しください");
    return;
  }

  let outBlob = blob;
  if (preset.dpi && state.format === "jpeg") {
    const bytes = setJpegDensity(await blob.arrayBuffer(), preset.dpi);
    outBlob = new Blob([bytes], { type: "image/jpeg" });
  } else if (preset.dpi && state.format === "png") {
    showToast("印刷サイズ情報の埋め込みはJPEG保存で有効になります");
  }

  const extension = state.format === "png" ? "png" : "jpg";
  const suffix = state.preset === "sheet" ? "-print" : "";
  const url = URL.createObjectURL(outBlob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `shukatsu-photo${suffix}.${extension}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(
    state.preset === "sheet"
      ? "L判印刷用シートを保存しました。コンビニのL判写真プリントで印刷できます"
      : `高画質の証明写真を保存しました（${formatBytes(outBlob.size)}）`
  );
});

// ---- 長押しで元写真と比較 ----
const compareButton = $("#compareButton");
function setShowOriginal(value) {
  if (state.showOriginal === value) return;
  state.showOriginal = value;
  compareButton.classList.toggle("holding", value);
  state.renderQueued = false;
  requestAnimationFrame(renderPreview);
}
compareButton.addEventListener("pointerdown", event => {
  event.preventDefault();
  compareButton.setPointerCapture(event.pointerId);
  setShowOriginal(true);
});
["pointerup", "pointercancel", "pointerleave"].forEach(type =>
  compareButton.addEventListener(type, () => setShowOriginal(false))
);
compareButton.addEventListener("keydown", event => {
  if (event.key === " " || event.key === "Enter") setShowOriginal(true);
});
compareButton.addEventListener("keyup", () => setShowOriginal(false));

let pointerStart = null;
$("#photoStage").addEventListener("pointerdown", event => {
  if (!state.image) return;
  event.currentTarget.setPointerCapture(event.pointerId);
  state.dragging = true;
  pointerStart = { x: event.clientX, y: event.clientY, offsetX: state.offsetX, offsetY: state.offsetY };
});

$("#photoStage").addEventListener("pointermove", event => {
  if (!state.dragging || !pointerStart) return;
  const rect = event.currentTarget.getBoundingClientRect();
  state.offsetX = pointerStart.offsetX + (event.clientX - pointerStart.x) / rect.width;
  state.offsetY = pointerStart.offsetY + (event.clientY - pointerStart.y) / rect.height;
  scheduleRender();
});

function endDrag() {
  state.dragging = false;
  pointerStart = null;
}
$("#photoStage").addEventListener("pointerup", endDrag);
$("#photoStage").addEventListener("pointercancel", endDrag);

$("#photoStage").addEventListener("wheel", event => {
  if (!state.image) return;
  event.preventDefault();
  state.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, state.scale - event.deltaY * .001));
  scheduleRender();
}, { passive: false });

let pinchDistance = null;
const activePointers = new Map();
$("#photoStage").addEventListener("pointerdown", event => {
  activePointers.set(event.pointerId, event);
});
$("#photoStage").addEventListener("pointermove", event => {
  if (!activePointers.has(event.pointerId)) return;
  activePointers.set(event.pointerId, event);
  if (activePointers.size === 2) {
    const [a, b] = [...activePointers.values()];
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (pinchDistance) state.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, state.scale * (distance / pinchDistance)));
    pinchDistance = distance;
    scheduleRender();
  }
});
const clearPointer = event => {
  activePointers.delete(event.pointerId);
  if (activePointers.size < 2) pinchDistance = null;
};
$("#photoStage").addEventListener("pointerup", clearPointer);
$("#photoStage").addEventListener("pointercancel", clearPointer);

// ---- カメラ・セルフタイマー ----

async function openCamera() {
  const dialog = $("#cameraDialog");
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast("このブラウザではカメラを利用できません。写真を選んでください");
    $("#fileInput").click();
    return;
  }

  try {
    stopCamera();
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: state.facingMode,
        width: { ideal: 1920 },
        height: { ideal: 1440 }
      },
      audio: false
    });
    $("#cameraVideo").srcObject = state.stream;
    $("#cameraVideo").style.transform = state.facingMode === "user" ? "scaleX(-1)" : "none";
    if (!dialog.open) dialog.showModal();
  } catch (error) {
    showToast("カメラを開始できませんでした。写真を選ぶ方法も使えます");
  }
}

function stopCamera() {
  cancelCountdown();
  if (state.stream) {
    state.stream.getTracks().forEach(track => track.stop());
    state.stream = null;
  }
  $("#cameraVideo").srcObject = null;
}

function cancelCountdown() {
  if (state.countdownHandle) {
    clearInterval(state.countdownHandle);
    state.countdownHandle = null;
  }
  const countdown = $("#timerCountdown");
  countdown.hidden = true;
  countdown.textContent = "";
  $("#shutterButton").classList.remove("counting");
}

function capturePhoto() {
  const video = $("#cameraVideo");
  if (!video.videoWidth) return;
  const capture = document.createElement("canvas");
  capture.width = video.videoWidth;
  capture.height = video.videoHeight;
  const captureCtx = capture.getContext("2d");
  if (state.facingMode === "user") {
    captureCtx.translate(capture.width, 0);
    captureCtx.scale(-1, 1);
  }
  captureCtx.drawImage(video, 0, 0);
  const image = new Image();
  image.onload = () => setSourceImage(image);
  image.src = capture.toDataURL("image/jpeg", .96);
  $("#cameraDialog").close();
  stopCamera();
}

$("#cameraButton").addEventListener("click", openCamera);
$("#switchCameraButton").addEventListener("click", async () => {
  state.facingMode = state.facingMode === "user" ? "environment" : "user";
  await openCamera();
});

$$(".timer-chip").forEach(button => button.addEventListener("click", () => {
  state.timerSeconds = Number(button.dataset.timer);
  $$(".timer-chip").forEach(item => item.classList.toggle("active", item === button));
}));

$("#shutterButton").addEventListener("click", () => {
  // カウントダウン中にもう一度押したらキャンセル
  if (state.countdownHandle) {
    cancelCountdown();
    return;
  }
  if (state.timerSeconds === 0) {
    capturePhoto();
    return;
  }

  let remaining = state.timerSeconds;
  const countdown = $("#timerCountdown");
  countdown.hidden = false;
  countdown.textContent = remaining;
  $("#shutterButton").classList.add("counting");
  state.countdownHandle = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      cancelCountdown();
      capturePhoto();
    } else {
      countdown.textContent = remaining;
    }
  }, 1000);
});

$(".dialog-close", $("#cameraDialog")).addEventListener("click", () => $("#cameraDialog").close());
$("#cameraDialog").addEventListener("close", stopCamera);

$("#helpButton").addEventListener("click", () => $("#helpDialog").showModal());
$(".help-close").addEventListener("click", () => $("#helpDialog").close());
$(".help-got-it").addEventListener("click", () => $("#helpDialog").close());

for (const dialog of $$("dialog")) {
  dialog.addEventListener("click", event => {
    if (event.target === dialog) dialog.close();
  });
}

window.addEventListener("beforeunload", stopCamera);
updateExportText();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
