const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const canvas = $("#previewCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const sourceCanvas = document.createElement("canvas");
const sourceCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });
const processedCanvas = document.createElement("canvas");
const processedCtx = processedCanvas.getContext("2d", { willReadFrequently: true });

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
  renderQueued: false
};

const presets = {
  es: { width: 1200, height: 1600, label: "1200 × 1600 px" },
  resume: { width: 900, height: 1200, label: "30 × 40 mm / 300dpi" }
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

function updateExportText() {
  const preset = presets[state.preset];
  $("#exportName").textContent = `shukatsu-photo.${state.format === "jpeg" ? "jpg" : "png"}`;
  $("#exportDetails").textContent = `${state.format.toUpperCase()}・${preset.width} × ${preset.height} px・高画質`;
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

    state.image = image;
    state.scale = 1;
    state.offsetX = 0;
    state.offsetY = 0;
    const emptyState = $("#emptyState");
    emptyState.hidden = true;
    emptyState.classList.add("is-hidden");
    $("#cropGuides").hidden = false;
    $("#stageHint").classList.add("active");
    $("#downloadButton").disabled = false;
    scheduleRender();
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

function colorDistance(r, g, b, sample) {
  const dr = r - sample.r;
  const dg = g - sample.g;
  const db = b - sample.b;
  return Math.sqrt(dr * dr * .8 + dg * dg * 1.15 + db * db * .7);
}

function getCornerBackgroundSamples(imageData, width, height) {
  const data = imageData.data;
  const samples = [];
  const areas = [
    [0, 0, .13, .11],
    [.87, 0, 1, .11],
    [0, .89, .1, 1],
    [.9, .89, 1, 1]
  ];

  for (const [sx, sy, ex, ey] of areas) {
    let r = 0, g = 0, b = 0, count = 0;
    const step = Math.max(1, Math.round(width / 160));
    for (let y = Math.floor(height * sy); y < Math.floor(height * ey); y += step) {
      for (let x = Math.floor(width * sx); x < Math.floor(width * ex); x += step) {
        const i = (y * width + x) * 4;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; count++;
      }
    }
    samples.push({ r: r / count, g: g / count, b: b / count });
  }
  return samples;
}

function hexToRgb(hex) {
  const number = parseInt(hex.slice(1), 16);
  return { r: number >> 16, g: (number >> 8) & 255, b: number & 255 };
}

function softenBackground(imageData, width, height, backgroundHex) {
  const data = imageData.data;
  const samples = getCornerBackgroundSamples(imageData, width, height);
  const target = hexToRgb(backgroundHex);
  const centerX = width / 2;
  const centerY = height * .47;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      let distance = Infinity;
      for (const sample of samples) {
        distance = Math.min(distance, colorDistance(r, g, b, sample));
      }

      const normalizedX = Math.abs(x - centerX) / centerX;
      const normalizedY = Math.abs(y - centerY) / height;
      const personProtection = Math.max(0, 1 - normalizedX * 1.8) * Math.max(0, 1 - normalizedY * 1.4);
      const edgeBias = Math.min(1, normalizedX * 1.35 + Math.max(0, y / height - .83));
      const threshold = 25 + edgeBias * 30 - personProtection * 18;
      let mix = 1 - Math.max(0, Math.min(1, (distance - threshold) / 28));
      mix *= .94;

      if (y > height * .72 && normalizedX < .52) mix *= .25;
      if (y > height * .82 && normalizedX < .72) mix *= .45;

      if (mix > .01) {
        data[i] = r * (1 - mix) + target.r * mix;
        data[i + 1] = g * (1 - mix) + target.g * mix;
        data[i + 2] = b * (1 - mix) + target.b * mix;
      }
    }
  }
  return imageData;
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

  processedCanvas.width = width;
  processedCanvas.height = height;
  processedCtx.clearRect(0, 0, width, height);
  processedCtx.imageSmoothingEnabled = true;
  processedCtx.imageSmoothingQuality = "high";
  const smoothAmount = highQuality ? state.smooth * .32 : state.smooth * .22;
  processedCtx.filter = `brightness(${state.brightness}%) contrast(${state.contrast}%) blur(${smoothAmount}px)`;
  processedCtx.drawImage(sourceCanvas, transform.x, transform.y, transform.width, transform.height);
  processedCtx.filter = "none";

  if (state.removeBackground && state.background !== "original") {
    let pixels = processedCtx.getImageData(0, 0, width, height);
    pixels = softenBackground(pixels, width, height, state.background);
    pixels = applyWarmth(pixels, state.warmth);
    processedCtx.putImageData(pixels, 0, 0);
  } else if (state.warmth !== 0) {
    let pixels = processedCtx.getImageData(0, 0, width, height);
    pixels = applyWarmth(pixels, state.warmth);
    processedCtx.putImageData(pixels, 0, 0);
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
  scheduleRender();
}));

$("#backgroundToggle").addEventListener("change", event => {
  state.removeBackground = event.target.checked;
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
  scheduleRender();
  showToast("背景を白く均一に整えました");
});

$("#resetButton").addEventListener("click", () => {
  resetAdjustments();
  showToast("調整をリセットしました");
});

$$(".format-button").forEach(button => button.addEventListener("click", () => {
  state.format = button.dataset.format;
  $$(".format-button").forEach(item => item.classList.toggle("active", item === button));
  updateExportText();
}));

$("#downloadButton").addEventListener("click", () => {
  if (!state.image) return;
  const preset = presets[state.preset];
  const exportCanvas = document.createElement("canvas");
  renderTo(exportCanvas, preset.width, preset.height, true);
  const mime = state.format === "png" ? "image/png" : "image/jpeg";
  const extension = state.format === "png" ? "png" : "jpg";
  exportCanvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `shukatsu-photo.${extension}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("高画質の証明写真を保存しました");
  }, mime, .96);
});

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
  state.scale = Math.max(1, Math.min(2.5, state.scale - event.deltaY * .001));
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
    if (pinchDistance) state.scale = Math.max(1, Math.min(2.5, state.scale * (distance / pinchDistance)));
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
  if (state.stream) {
    state.stream.getTracks().forEach(track => track.stop());
    state.stream = null;
  }
  $("#cameraVideo").srcObject = null;
}

$("#cameraButton").addEventListener("click", openCamera);
$("#switchCameraButton").addEventListener("click", async () => {
  state.facingMode = state.facingMode === "user" ? "environment" : "user";
  await openCamera();
});

$("#shutterButton").addEventListener("click", () => {
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
