// Firebase 設定
// ※新しい Firebase プロジェクトの設定値に置き換えてください（他のファイルと同じ内容にする）
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.firebasestorage.app",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

const SONGS_COLLECTION = "songs";

// 読み込むパートファイル一覧（存在しないファイルはスキップされる）
// instrument は soundfont-player 経由で読み込む General MIDI 音源名
// （全パートともピアノ音源で統一）
const PART_FILES = [
  { key: "piano", label: "伴奏", file: "piano.txt", instrument: "acoustic_grand_piano" },
  { key: "soprano", label: "ソプラノ", file: "soprano.txt", instrument: "acoustic_grand_piano" },
  { key: "alto", label: "アルト", file: "alto.txt", instrument: "acoustic_grand_piano" },
  { key: "tenor", label: "テノール", file: "tenor.txt", instrument: "acoustic_grand_piano" },
  { key: "bath", label: "バス", file: "bath.txt", instrument: "acoustic_grand_piano" },
];

window.app = firebase.initializeApp(firebaseConfig);
window.auth = firebase.auth();
window.db = firebase.firestore();
window.storage = firebase.storage();

// ==============================
// section.txt / パートファイル パーサー
// ==============================

// 音名 -> 基準（ナチュラル）の半音番号（C=0基準）
const BASE_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// 標準のオクターブ表記（A4 = 440Hz, C4 = 真ん中のド）でMIDIノート番号を計算
// soundfont-player はこのMIDIノート番号を使ってサンプル音源を鳴らす
function noteToMidi(letter, octave, accidental) {
  let semitone = BASE_SEMITONE[letter];
  if (accidental === "flat") semitone -= 1;
  if (accidental === "sharp") semitone += 1;
  return (octave + 1) * 12 + semitone;
}

// section.txt をパースし、小節ごとのタイミング情報を計算する
function parseSectionFile(text) {
  const lines = text.split(/\r?\n/);
  const measures = [];
  let currentBpm = 120;
  let currentSection = null;
  const tone = {}; // 例: { B: 'flat', E: 'flat' }
  let startIndex = 0;

  lines.forEach((rawLine, lineNo) => {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("//")) return;

    if (line.startsWith("#BPM")) {
      const m = line.match(/^#BPM\s+(\d+(?:\.\d+)?)/);
      if (m) currentBpm = parseFloat(m[1]);
      else console.warn(`section.txt ${lineNo + 1}行目: #BPM の形式が不正です`, rawLine);
      return;
    }
    if (line.startsWith("#TONE")) {
      const rest = line.slice(5).trim();
      rest.split("|").forEach((tok) => {
        const mm = tok.trim().match(/^([A-Ga-g])(flat|sharp)$/i);
        if (mm) tone[mm[1].toUpperCase()] = mm[2].toLowerCase();
      });
      return;
    }
    if (line.startsWith("#START")) {
      startIndex = measures.length;
      return;
    }
    if (line.startsWith("@")) {
      currentSection = line.slice(1).trim();
      return;
    }

    const measureMatch = line.match(/^(\d+)\/(\d+)\s*x\s*(\d+)$/i);
    if (measureMatch) {
      const num = parseInt(measureMatch[1], 10);
      const den = parseInt(measureMatch[2], 10);
      const count = parseInt(measureMatch[3], 10);
      for (let i = 0; i < count; i++) {
        measures.push({
          timeSigNum: num,
          timeSigDen: den,
          bpm: currentBpm,
          section: currentSection,
        });
      }
      return;
    }

    console.warn(`section.txt ${lineNo + 1}行目: 解釈できない行をスキップしました`, rawLine);
  });

  // 表示用の小節番号・絶対時間を計算
  let cursorSec = 0;
  measures.forEach((measure, i) => {
    measure.number = i - startIndex + 1;
    const wholeNoteSec = 240 / measure.bpm; // 全音符の長さ（BPMは4分音符基準）
    measure.durationSec = (measure.timeSigNum / measure.timeSigDen) * wholeNoteSec;
    measure.startSec = cursorSec;
    cursorSec += measure.durationSec;
  });

  const measureByNumber = new Map();
  measures.forEach((m) => measureByNumber.set(m.number, m));

  // セクションの開始時刻一覧（ジャンプボタン用。同名セクションが複数あれば最初の登場位置）
  const sections = [];
  const seenSections = new Set();
  measures.forEach((m) => {
    if (m.section && !seenSections.has(m.section)) {
      seenSections.add(m.section);
      sections.push({ name: m.section, startSec: m.startSec });
    }
  });

  return {
    measures,
    measureByNumber,
    tone,
    sections,
    totalDurationSec: cursorSec,
  };
}

// パートファイル（soprano.txt など）の1行を解釈する
// 想定形式: (小節番号)|(オフセット分子)/(オフセット分母)|(長さ分子)/(長さ分母)|(音名)(オクターブ省略可)
const NOTE_LINE_STRICT = /^(-?\d+)\|(\d+)\/(\d+)\|(\d+)\/(\d+)\|([A-Ga-g])(\d*)$/;
// スラッシュ抜けなど、パイプ区切りになってしまっている場合の救済用（例: 12|14|16|1/8|B）
const NOTE_LINE_LENIENT = /^(-?\d+)\|(\d+)\|(\d+)\|(\d+)\/(\d+)\|([A-Ga-g])(\d*)$/;

function parsePartFile(text, tone, measureByNumber, fileName) {
  const lines = text.split(/\r?\n/);
  const notes = [];

  lines.forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("//")) return;

    let m = line.match(NOTE_LINE_STRICT);
    let usedLenientFallback = false;
    if (!m) {
      m = line.match(NOTE_LINE_LENIENT);
      usedLenientFallback = !!m;
    }
    if (!m) {
      console.warn(`${fileName} ${idx + 1}行目: 解釈できない行をスキップしました`, rawLine);
      return;
    }
    if (usedLenientFallback) {
      console.warn(
        `${fileName} ${idx + 1}行目: "|"と"/"の区切りが不正な可能性があります（オフセット部分をスラッシュ区切りとして解釈しました）`,
        rawLine
      );
    }

    const measureNumber = parseInt(m[1], 10);
    const offsetNum = parseInt(m[2], 10);
    const offsetDen = parseInt(m[3], 10);
    const durNum = parseInt(m[4], 10);
    const durDen = parseInt(m[5], 10);
    const letter = m[6].toUpperCase();
    const octave = m[7] === "" ? 3 : parseInt(m[7], 10);

    const measure = measureByNumber.get(measureNumber);
    if (!measure) {
      console.warn(`${fileName} ${idx + 1}行目: 小節番号 ${measureNumber} は section.txt に存在しません`, rawLine);
      return;
    }

    const wholeNoteSec = 240 / measure.bpm;
    const startSec = measure.startSec + (offsetNum / offsetDen) * wholeNoteSec;
    const durSec = (durNum / durDen) * wholeNoteSec;

    const accidental = tone[letter]; // #TONE で指定されていれば自動適用
    const midi = noteToMidi(letter, octave, accidental);

    notes.push({ measureNumber, startSec, durSec, letter, octave, midi });
  });

  return notes;
}

// ==============================
// 再生エンジン（Web Audio）
// テンポを変えても音の高さは変わらず、タイミングだけがスケールする
// ==============================
class ChorusPlayer {
  constructor(totalDurationSec) {
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    this.parts = {}; // key -> { notes, gainNode, muted, volume }
    this.speed = 1.0;
    this.isPlaying = false;
    this.positionSec = 0;
    this.anchorAudioTime = 0;
    this.anchorSongTime = 0;
    this.totalDurationSec = totalDurationSec;
    this.scheduledNodes = [];
    this.onTimeUpdate = null;
    this.onEnded = null;
    this.rafId = null;
  }

  // instrumentName は soundfont-player 経由で読み込む General MIDI 音源名
  // （例: 'acoustic_grand_piano', 'choir_aahs'）。実際にサンプリングされた
  // 音声データを読み込むため、読み込みが完了するまで待つ必要がある。
  async addPart(key, notes, instrumentName, initialVolume = 0.8) {
    const gainNode = this.audioCtx.createGain();
    gainNode.gain.value = initialVolume;
    gainNode.connect(this.audioCtx.destination);

    const instrumentPlayer = await Soundfont.instrument(this.audioCtx, instrumentName, {
      destination: gainNode,
    });

    this.parts[key] = {
      notes,
      gainNode,
      instrumentPlayer,
      muted: false,
      volume: initialVolume,
    };
  }

  setVolume(key, volume) {
    const part = this.parts[key];
    if (!part) return;
    part.volume = volume;
    if (!part.muted) part.gainNode.gain.value = volume;
  }

  setMuted(key, muted) {
    const part = this.parts[key];
    if (!part) return;
    part.muted = muted;
    part.gainNode.gain.value = muted ? 0 : part.volume;
  }

  setSpeed(speed) {
    const wasPlaying = this.isPlaying;
    if (wasPlaying) this.pause();
    this.speed = speed;
    if (wasPlaying) this.play();
  }

  clearScheduled() {
    const stopTime = this.audioCtx.currentTime;
    this.scheduledNodes.forEach((node) => {
      try { node.stop(stopTime); } catch (e) { /* すでに停止済みの場合は無視 */ }
    });
    this.scheduledNodes = [];
  }

  scheduleFrom(positionSec) {
    this.clearScheduled();
    const startAudioTime = this.audioCtx.currentTime + 0.05;
    this.anchorAudioTime = startAudioTime;
    this.anchorSongTime = positionSec;

    Object.values(this.parts).forEach((part) => {
      if (!part.instrumentPlayer) return; // 読み込みが間に合っていない場合はスキップ
      part.notes.forEach((note) => {
        const noteEnd = note.startSec + note.durSec;
        if (noteEnd <= positionSec) return; // すでに終わった音はスケジュールしない

        const noteStartSec = Math.max(note.startSec, positionSec);
        const remainingDur = noteEnd - noteStartSec;
        if (remainingDur <= 0) return;

        const when = startAudioTime + (noteStartSec - positionSec) / this.speed;
        const dur = remainingDur / this.speed;

        // 実際にサンプリングされた音源（ピアノ/コーラス）を鳴らす
        const node = part.instrumentPlayer.play(note.midi, when, { duration: dur });
        this.scheduledNodes.push(node);
      });
    });
  }

  play() {
    if (this.isPlaying) return;
    if (this.audioCtx.state === "suspended") this.audioCtx.resume();
    this.isPlaying = true;
    this.scheduleFrom(this.positionSec);
    this._tick();
  }

  pause() {
    if (!this.isPlaying) return;
    this.positionSec = this.getCurrentPositionSec();
    this.isPlaying = false;
    this.clearScheduled();
    if (this.rafId) cancelAnimationFrame(this.rafId);
  }

  seek(positionSec) {
    const wasPlaying = this.isPlaying;
    if (wasPlaying) this.pause();
    this.positionSec = Math.max(0, Math.min(positionSec, this.totalDurationSec));
    if (wasPlaying) this.play();
    if (this.onTimeUpdate) this.onTimeUpdate(this.positionSec);
  }

  getCurrentPositionSec() {
    if (!this.isPlaying) return this.positionSec;
    return this.anchorSongTime + (this.audioCtx.currentTime - this.anchorAudioTime) * this.speed;
  }

  _tick() {
    if (!this.isPlaying) return;
    const pos = this.getCurrentPositionSec();
    if (pos >= this.totalDurationSec) {
      this.pause();
      this.positionSec = this.totalDurationSec;
      if (this.onTimeUpdate) this.onTimeUpdate(this.positionSec);
      if (this.onEnded) this.onEnded();
      return;
    }
    if (this.onTimeUpdate) this.onTimeUpdate(pos);
    this.rafId = requestAnimationFrame(() => this._tick());
  }
}

// ==============================
// 画面まわり
// ==============================

function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function findCurrentMeasure(measures, positionSec) {
  // 単純な線形探索（小節数が数百程度なら十分）
  let current = null;
  for (const m of measures) {
    if (m.startSec <= positionSec) current = m;
    else break;
  }
  return current;
}

async function fetchTextFile(songId, fileName) {
  try {
    const url = await storage.ref(`chorus/songs/${songId}/${fileName}`).getDownloadURL();
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    return null; // ファイルが存在しない場合（例: バスパートがない曲）
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const loadingOverlay = document.getElementById("loading-overlay");
  const loadingStatusText = document.getElementById("loading-status-text");
  const headerTitle = document.getElementById("header-title");
  const backButton = document.getElementById("back-button");
  const practiceMain = document.getElementById("practice-main");

  const seekBar = document.getElementById("seek-bar");
  const currentTimeText = document.getElementById("current-time-text");
  const totalTimeText = document.getElementById("total-time-text");
  const currentMeasureText = document.getElementById("current-measure-text");
  const playPauseButton = document.getElementById("play-pause-button");
  const speedSlider = document.getElementById("speed-slider");
  const speedValueText = document.getElementById("speed-value-text");
  const sectionJumpPanel = document.getElementById("section-jump-panel");
  const sectionJumpButtons = document.getElementById("section-jump-buttons");
  const partsList = document.getElementById("parts-list");

  backButton.addEventListener("click", () => {
    window.location.href = "./app.html";
  });

  const params = new URLSearchParams(window.location.search);
  const songId = params.get("song");

  if (!songId) {
    loadingStatusText.textContent = "曲が指定されていません。";
    return;
  }

  let player = null;
  let sectionData = null;
  let isSeeking = false;

  auth.onAuthStateChanged(async (user) => {
    if (!user) {
      window.location.href = "./index.html";
      return;
    }
    await loadSong(songId);
  });

  async function loadSong(id) {
    try {
      loadingStatusText.textContent = "曲情報を取得しています｡";
      const songDoc = await db.collection(SONGS_COLLECTION).doc(id).get();
      const songName = songDoc.exists ? songDoc.data().name : "(無題の曲)";
      headerTitle.textContent = songName;

      loadingStatusText.textContent = "楽譜データを読み込んでいます｡";
      const sectionText = await fetchTextFile(id, "section.txt");
      if (!sectionText) {
        loadingStatusText.textContent = "section.txt が見つかりませんでした。";
        return;
      }
      sectionData = parseSectionFile(sectionText);

      player = new ChorusPlayer(sectionData.totalDurationSec);

      for (const part of PART_FILES) {
        const text = await fetchTextFile(id, part.file);
        if (!text) continue; // このパートは存在しない（例: バスなし）
        const notes = parsePartFile(text, sectionData.tone, sectionData.measureByNumber, part.file);

        loadingStatusText.textContent = `${part.label}の音源を読み込んでいます｡`;
        await player.addPart(part.key, notes, part.instrument);
        addPartRow(part);
      }

      setupSectionButtons();
      setupTransportControls();

      totalTimeText.textContent = formatTime(sectionData.totalDurationSec);
      seekBar.max = String(Math.round(sectionData.totalDurationSec * 10));

      loadingOverlay.classList.add("hidden");
      practiceMain.classList.remove("hidden");
    } catch (error) {
      console.error("曲データの読み込みエラー:", error);
      loadingStatusText.textContent = "曲データの読み込みに失敗しました。";
    }
  }

  function addPartRow(part) {
    const row = document.createElement("div");
    row.className = "part-row";

    const muteButton = document.createElement("button");
    muteButton.className = "part-mute-button";
    muteButton.textContent = "🔊";
    muteButton.addEventListener("click", () => {
      const nowMuted = !muteButton.classList.contains("muted");
      muteButton.classList.toggle("muted", nowMuted);
      muteButton.textContent = nowMuted ? "🔇" : "🔊";
      player.setMuted(part.key, nowMuted);
    });

    const info = document.createElement("div");
    info.className = "part-info";

    const name = document.createElement("p");
    name.className = "part-name";
    name.textContent = part.label;

    const volumeSlider = document.createElement("input");
    volumeSlider.type = "range";
    volumeSlider.min = "0";
    volumeSlider.max = "100";
    volumeSlider.value = "80";
    volumeSlider.addEventListener("input", () => {
      player.setVolume(part.key, Number(volumeSlider.value) / 100);
    });

    info.appendChild(name);
    info.appendChild(volumeSlider);
    row.appendChild(muteButton);
    row.appendChild(info);
    partsList.appendChild(row);
  }

  function setupSectionButtons() {
    if (!sectionData.sections.length) return;
    sectionJumpPanel.classList.remove("hidden");
    sectionData.sections.forEach((section) => {
      const btn = document.createElement("button");
      btn.className = "section-jump-button";
      btn.textContent = section.name;
      btn.addEventListener("click", () => {
        player.seek(section.startSec);
        updateUiFromPosition(section.startSec);
      });
      sectionJumpButtons.appendChild(btn);
    });
  }

  function setupTransportControls() {
    playPauseButton.addEventListener("click", () => {
      if (player.isPlaying) {
        player.pause();
        playPauseButton.textContent = "再生";
      } else {
        player.play();
        playPauseButton.textContent = "一時停止";
      }
    });

    seekBar.addEventListener("input", () => {
      isSeeking = true;
      const pos = Number(seekBar.value) / 10;
      currentTimeText.textContent = formatTime(pos);
    });
    seekBar.addEventListener("change", () => {
      const pos = Number(seekBar.value) / 10;
      player.seek(pos);
      isSeeking = false;
    });

    speedSlider.addEventListener("input", () => {
      const percent = Number(speedSlider.value);
      speedValueText.textContent = `${percent}%`;
      player.setSpeed(percent / 100);
    });

    player.onTimeUpdate = (pos) => {
      updateUiFromPosition(pos);
    };
    player.onEnded = () => {
      playPauseButton.textContent = "再生";
    };
  }

  function updateUiFromPosition(pos) {
    if (!isSeeking) {
      seekBar.value = String(Math.round(pos * 10));
      currentTimeText.textContent = formatTime(pos);
    }
    const measure = findCurrentMeasure(sectionData.measures, pos);
    currentMeasureText.textContent = measure ? `小節 ${measure.number}` : "小節 --";

    // 現在のセクションボタンをハイライト
    document.querySelectorAll(".section-jump-button").forEach((btn) => {
      const isActive = measure && measure.section === btn.textContent;
      btn.classList.toggle("active", isActive);
    });
  }
});
