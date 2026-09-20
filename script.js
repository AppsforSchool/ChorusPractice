// Firebase 設定
// ※新しい Firebase プロジェクトの設定値に置き換えてください
const firebaseConfig = {
  apiKey: "AIzaSyDS2d02HUck9YyxWoX1WOQscyOr54DwyNQ",
  authDomain: "appsforschool-convenient.firebaseapp.com",
  projectId: "appsforschool-convenient",
  storageBucket: "appsforschool-convenient.firebasestorage.app",
  messagingSenderId: "1062735089267",
  appId: "1:1062735089267:web:ff185e6806c16b79f96406"
};

// ログイン時にIDへ付与するドメイン
// 例: クラス名 "3-1" → 3-1@chorus-appsforschool.com
const AUTH_EMAIL_DOMAIN = "@chorus-appsforschool.com";

// Firebase 初期化とサービス取得
window.app = firebase.initializeApp(firebaseConfig);
window.auth = firebase.auth();
window.db = firebase.firestore();

let loadingOverlay;
document.addEventListener("DOMContentLoaded", () => {
  loadingOverlay = document.getElementById("loading-overlay");
});

let loginContainer;
let idInput;
let passwordInput;
let loginButton;
let errorMessage;
document.addEventListener("DOMContentLoaded", () => {
  loginContainer = document.getElementById("login-container");
  idInput = document.getElementById("id");
  passwordInput = document.getElementById("password");
  loginButton = document.getElementById("login-button");
  errorMessage = document.getElementById("error-message");

  idInput.addEventListener("input", () => {
    updateLoginButtonState();
  });
  passwordInput.addEventListener("input", () => {
    updateLoginButtonState();
  });
  passwordInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !loginButton.disabled) {
      handleLogin();
    }
  });
  loginButton.addEventListener("click", () => {
    handleLogin();
  });

  updateLoginButtonState();
});

function updateLoginButtonState() {
  if (loginButton) {
    const hasId = idInput && idInput.value.trim() !== '';
    const hasPassword = passwordInput && passwordInput.value.trim() !== '';
    // 両方入力されていればボタンを有効、そうでなければ無効
    loginButton.disabled = !(hasId && hasPassword);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  auth.onAuthStateChanged(async (user) => {
    if (user) {
      window.location.href = './app.html';
      loginContainer.classList.add("hidden");
    } else {
      loadingOverlay.classList.add("hidden");
      loginContainer.classList.remove("hidden");
    }
  });
});

const handleLogin = async () => {
  errorMessage.textContent = ''; // エラーメッセージをクリア

  // ログイン処理開始時の視覚的フィードバック
  loginButton.disabled = true; // ボタンを無効化して多重クリックを防ぐ
  loginButton.textContent = 'ログイン中...'; // テキストで処理中であることを表示

  try {
    // クラス名(または管理者ID等)をそのままメールアドレスのローカル部として使用
    const classId = idInput.value.trim();
    const loginEmail = `${classId}${AUTH_EMAIL_DOMAIN}`;
    await auth.signInWithEmailAndPassword(loginEmail, passwordInput.value);
  } catch (error) {
    errorMessage.textContent = 'ログインに失敗しました。IDとパスワードを確認してください。';
    console.error("ログインエラー:", error);
    loginButton.disabled = false;
    loginButton.textContent = 'ログイン';
  }
};
