// Firebase 設定
// ※新しい Firebase プロジェクトの設定値に置き換えてください（script.js と同じ内容にする）
const firebaseConfig = {
  apiKey: "AIzaSyDS2d02HUck9YyxWoX1WOQscyOr54DwyNQ",
  authDomain: "appsforschool-convenient.firebaseapp.com",
  projectId: "appsforschool-convenient",
  storageBucket: "appsforschool-convenient.firebasestorage.app",
  messagingSenderId: "1062735089267",
  appId: "1:1062735089267:web:ff185e6806c16b79f96406"
};

const AUTH_EMAIL_DOMAIN = "@chorus-appsforschool.com";

// 曲データを保存している Firestore コレクション名
// (仮) 各ドキュメントIDが chorus/songs/(曲ごとのid)/ のフォルダ名と対応する想定
const SONGS_COLLECTION = "songs";

// このパターンに一致するID(例: 3-1)は「クラスアカウント」として扱う。
// 一致しないID(例: admin, teacher)は「特別なアカウント」として全曲を表示する。
const CLASS_ID_PATTERN = /^\d+-\d+$/;

window.app = firebase.initializeApp(firebaseConfig);
window.auth = firebase.auth();
window.db = firebase.firestore();

let loadingOverlay;
let loadingStatusText;
let loadingText;
let emptyText;
let cardArea;
let currentClassId = null;

document.addEventListener("DOMContentLoaded", () => {
  loadingOverlay = document.getElementById("loading-overlay");
  loadingStatusText = document.getElementById("loading-status-text");
  loadingText = document.getElementById("loading-text");
  emptyText = document.getElementById("empty-text");
  cardArea = document.getElementById("card-area");
});

// --- 認証チェック ---
document.addEventListener("DOMContentLoaded", () => {
  auth.onAuthStateChanged(async (user) => {
    if (!user) {
      window.location.href = "./index.html";
      return;
    }

    currentClassId = (user.email || "").replace(AUTH_EMAIL_DOMAIN, "");
    const drawerClassId = document.getElementById("drawerClassId");
    if (drawerClassId) drawerClassId.textContent = currentClassId;

    loadingOverlay.classList.add("hidden");
    await loadSongs();
  });
});

// --- 曲一覧の読み込み ---
async function loadSongs() {
  loadingText.classList.remove("hidden");
  emptyText.classList.add("hidden");
  cardArea.classList.add("hidden");
  cardArea.innerHTML = "";

  try {
    let querySnapshot;
    if (CLASS_ID_PATTERN.test(currentClassId)) {
      // クラスアカウント: member 配列に自分のクラスが含まれる曲のみ取得
      querySnapshot = await db
        .collection(SONGS_COLLECTION)
        .where("member", "array-contains", currentClassId)
        .get();
    } else {
      // 先生・管理者などの特別なアカウント: すべての曲を取得
      querySnapshot = await db.collection(SONGS_COLLECTION).get();
    }

    loadingText.classList.add("hidden");

    if (querySnapshot.empty) {
      emptyText.classList.remove("hidden");
      return;
    }

    querySnapshot.forEach((doc) => {
      const data = doc.data();
      cardArea.appendChild(createSongCard(doc.id, data));
    });
    cardArea.classList.remove("hidden");
  } catch (error) {
    console.error("曲一覧の取得エラー:", error);
    loadingText.textContent = "曲一覧の取得に失敗しました。";
  }
}

function createSongCard(songId, data) {
  const card = document.createElement("div");
  card.className = "song-card";

  const name = document.createElement("p");
  name.className = "song-name";
  name.textContent = data.name || "(無題の曲)";
  card.appendChild(name);

  card.addEventListener("click", () => {
    window.location.href = `./practice.html?song=${encodeURIComponent(songId)}`;
  });

  return card;
}

// --- アカウント設定ドロワー ---
let drawerOverlay;
let accountSettingsDrawer;
let drawerCloseButton;
let settingButton;
let logoutButton;

document.addEventListener("DOMContentLoaded", () => {
  drawerOverlay = document.getElementById("drawerOverlay");
  accountSettingsDrawer = document.getElementById("accountSettingsDrawer");
  drawerCloseButton = document.getElementById("drawerCloseButton");
  settingButton = document.getElementById("setting-button");
  logoutButton = document.getElementById("logout-button");

  settingButton.addEventListener("click", () => openDrawer());
  drawerCloseButton.addEventListener("click", () => closeDrawer());
  drawerOverlay.addEventListener("click", () => closeDrawer());

  logoutButton.addEventListener("click", async () => {
    await auth.signOut();
    window.location.href = "./index.html";
  });
});

function openDrawer() {
  drawerOverlay.classList.add("visible");
  accountSettingsDrawer.classList.add("open");
}
function closeDrawer() {
  drawerOverlay.classList.remove("visible");
  accountSettingsDrawer.classList.remove("open");
}
