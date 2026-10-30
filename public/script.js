const $ = (id) => document.getElementById(id);

const state = {
  files: [],
  sel: 0,
  type: "text",
  position: "br",
  x: 50,
  y: 50,
  small: null,
};

// The server's limits, so the page can refuse files before uploading them. Defaults match the server's.
const limits = { maxFiles: 20, maxFileMb: 15 };
fetch("/api/config")
  .then((r) => (r.ok ? r.json() : null))
  .then((c) => c && Object.assign(limits, c))
  .catch(() => {});

/** The error message from a failed response, even when it isn't JSON (e.g. a proxy error page). */
async function errorFrom(r) {
  const body = await r.json().catch(() => null);
  if (body?.error) return body.error;
  return r.status === 429 ? "Too many requests. Wait a minute and try again." : "Something went wrong. Try again.";
}

const POS9 = ["tl", "tc", "tr", "ml", "c", "mr", "bl", "bc", "br"];

// ---------- position pickers ----------
POS9.forEach((p) => {
  const b = document.createElement("button");
  b.dataset.pos = p;
  $("grid9").appendChild(b);
});
document.querySelectorAll("[data-pos]").forEach(
  (b) =>
    (b.onclick = () => {
      state.position = b.dataset.pos;
      syncUI();
      schedule();
    }),
);

document.querySelectorAll("#typeSeg button").forEach(
  (b) =>
    (b.onclick = () => {
      state.type = b.dataset.v;
      syncUI();
      schedule();
    }),
);

function syncUI() {
  document
    .querySelectorAll("[data-pos]")
    .forEach((b) => b.classList.toggle("on", b.dataset.pos === state.position));
  document
    .querySelectorAll("#typeSeg button")
    .forEach((b) => b.classList.toggle("on", b.dataset.v === state.type));
  $("textOpts").classList.toggle("hidden", state.type !== "text");
  $("imgOpts").classList.toggle("hidden", state.type !== "image");
  $("gapWrap").classList.toggle("hidden", state.position !== "tile");
  $("marginWrap").classList.toggle(
    "hidden",
    state.position === "tile" || state.position === "custom",
  );
  $("sizeV").textContent = $("size").value + "%";
  $("opacityV").textContent = $("opacity").value + "%";
  $("angleV").textContent = $("angle").value + "°";
  $("marginV").textContent = $("margin").value + "%";
  $("gapV").textContent = $("gap").value + "%";
  $("qualityV").textContent = $("quality").value;
  $("go").disabled = !state.files.length;
  $("go").textContent =
    state.files.length > 1
      ? `Watermark ${state.files.length} images → ZIP`
      : "Watermark & download";
}

function options() {
  return {
    type: state.type,
    text: $("text").value,
    font: $("font").value,
    color: $("color").value,
    bold: $("bold").checked,
    size: +$("size").value,
    opacity: +$("opacity").value / 100,
    angle: +$("angle").value,
    position: state.position,
    margin: +$("margin").value,
    gap: +$("gap").value,
    x: state.x,
    y: state.y,
    format: $("format").value,
    quality: +$("quality").value,
  };
}

// ---------- files ----------
$("drop").onclick = () => $("files").click();
$("drop").ondragover = (e) => {
  e.preventDefault();
  $("drop").classList.add("over");
};
$("drop").ondragleave = () => $("drop").classList.remove("over");
$("drop").ondrop = (e) => {
  e.preventDefault();
  $("drop").classList.remove("over");
  addFiles(e.dataTransfer.files);
};
$("files").onchange = (e) => {
  addFiles(e.target.files);
  e.target.value = "";
};

function addFiles(list) {
  const skipped = [];
  for (const f of list) {
    if (!f.type.startsWith("image/")) continue;
    if (state.files.length >= limits.maxFiles) {
      skipped.push(`max ${limits.maxFiles} images`);
      break;
    }
    if (f.size > limits.maxFileMb * 1024 * 1024) {
      skipped.push(`${f.name} is over ${limits.maxFileMb} MB`);
      continue;
    }
    state.files.push({ file: f, url: URL.createObjectURL(f) });
  }
  setStatus(skipped.length ? "Skipped: " + skipped.join(", ") : "", skipped.length > 0);
  renderThumbs();
  selectFile(
    state.files.length ? Math.min(state.sel, state.files.length - 1) : 0,
  );
}
function renderThumbs() {
  $("thumbs").innerHTML = "";
  state.files.forEach((it, i) => {
    const d = document.createElement("div");
    d.className = "th" + (i === state.sel ? " sel" : "");
    d.innerHTML = `<img src="${it.url}"><b title="Remove">×</b>`;
    d.onclick = () => selectFile(i);
    d.querySelector("b").onclick = (e) => {
      e.stopPropagation();
      state.files.splice(i, 1);
      state.sel = 0;
      renderThumbs();
      selectFile(0);
    };
    $("thumbs").appendChild(d);
  });
}
async function selectFile(i) {
  state.sel = i;
  state.small = null;
  renderThumbs();
  syncUI();
  const it = state.files[i];
  if (!it) {
    $("preview").style.display = "none";
    $("empty").style.display = "";
    $("pvName").textContent = "";
    return;
  }
  $("pvName").textContent = "· " + it.file.name;
  state.small = await downscale(it.file, 1000);
  schedule(0);
}
async function downscale(file, maxW) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });

  const s = Math.min(1, maxW / bmp.width),
    c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, "image/jpeg", 0.88));
}

// ---------- live preview (debounced) ----------
let timer,
  seq = 0,
  inflight = null;
function schedule(ms = 300) {
  syncUI();
  clearTimeout(timer);
  timer = setTimeout(renderPreview, ms);
}
async function renderPreview() {
  if (!state.small) return;
  if (state.type === "image" && !$("logo").files[0]) return;
  const my = ++seq,
    fd = new FormData();
  // A newer preview replaces the one still loading, so the server only works on the latest settings.
  inflight?.abort();
  inflight = new AbortController();
  fd.append("options", JSON.stringify(options()));
  fd.append("images", state.small, "preview.jpg");
  if (state.type === "image") fd.append("logo", $("logo").files[0]);

  try {
    const r = await fetch("/api/preview", { method: "POST", body: fd, signal: inflight.signal });
    if (!r.ok) throw new Error(await errorFrom(r));

    if (my !== seq) return;
    const old = $("preview").src;
    $("preview").src = URL.createObjectURL(await r.blob());
    
    if (old.startsWith("blob:")) URL.revokeObjectURL(old);
    $("preview").style.display = "block";
    $("empty").style.display = "none";
    setStatus("");
  } catch (e) {
    if (e.name !== "AbortError") setStatus(e.message, true);
  }
}
[
  "text",
  "font",
  "color",
  "bold",
  "size",
  "opacity",
  "angle",
  "margin",
  "gap",
  "format",
  "quality",
  "logo",
].forEach((id) => $(id).addEventListener("input", () => schedule()));
$("preview").onclick = (e) => {
  if (state.position !== "custom") return;
  const r = $("preview").getBoundingClientRect();
  state.x = ((e.clientX - r.left) / r.width) * 100;
  state.y = ((e.clientY - r.top) / r.height) * 100;
  schedule(0);
};

// ---------- export ----------
function setStatus(m, err) {
  $("status").textContent = m;
  $("status").className = err ? "err" : "";
}
$("go").onclick = async () => {
  if (state.type === "image" && !$("logo").files[0])
    return setStatus("Choose a logo file first.", true);
  const fd = new FormData();
  fd.append("options", JSON.stringify(options()));
  state.files.forEach((it) => fd.append("images", it.file));
  if (state.type === "image") fd.append("logo", $("logo").files[0]);
  $("go").disabled = true;
  setStatus(
    `Processing ${state.files.length} image${state.files.length > 1 ? "s" : ""}…`,
  );
  try {
    const r = await fetch("/api/watermark", { method: "POST", body: fd });
    if (!r.ok) throw new Error(await errorFrom(r));
    const blob = await r.blob();
    const name =
      /filename="([^"]+)"/.exec(
        r.headers.get("Content-Disposition") || "",
      )?.[1] || "watermarked";
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(blob),
      download: name,
    });
    a.click();
    // Free the (possibly large) download from memory once the browser has started saving it.
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    setStatus("Done " + name);
  } catch (e) {
    setStatus(e.message, true);
  }
  $("go").disabled = !state.files.length;
};
syncUI();
