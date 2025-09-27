(async function () {
  const token = localStorage.getItem("CHAT_TOKEN");
  if (!token) return (location.href = "../html/login.html");

  // fetch my profile
  const meRes = await fetch("/api/me", {
    headers: { Authorization: "Bearer " + token },
  });
  if (!meRes.ok) {
    localStorage.removeItem("CHAT_TOKEN");
    return (location.href = "../html/login.html");
  }
  const me = await meRes.json();
  document.getElementById("userInfo").innerText = me.username;
  document.getElementById("meAvatar").src =
    me.avatar_path || "/uploads/anon.png";
  // anonymous toggle
  let anonymousMode = false;
  const anonBtn = document.getElementById("anonToggle");
  anonBtn.onclick = () => {
    anonymousMode = !anonymousMode;
    anonBtn.style.opacity = anonymousMode ? "0.7" : "1";
  };
  document.getElementById("logoutBtn").onclick = () => {
    localStorage.removeItem("CHAT_TOKEN");
    location.href = "../html/login.html";
  };

  // socket.io connect with auth
  const socket = io({ auth: { token } });
  const chatWindow = document.getElementById("chatWindow");

  function renderMessage(m) {
    const row = document.createElement("div");
    row.className =
      "msg-row " + (m.user_id === me.id && !m.anonymous ? "right" : "");
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    // show black avatar for anonymous
    if (m.anonymous) {
      avatar.classList.add("black");
      avatar.innerText = "A";
    } else if (m.avatar_path) {
      const img = document.createElement("img");
      img.src = m.avatar_path;
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.objectFit = "cover";
      avatar.appendChild(img);
    } else {
      avatar.innerText = m.sender_name
        ? m.sender_name.charAt(0).toUpperCase()
        : "?";
    }
    const bubble = document.createElement("div");
    bubble.className =
      "bubble " + (m.user_id === me.id && !m.anonymous ? "out" : "in");
    bubble.innerHTML = `<div>${escapeHtml(
      m.content
    )}</div><div class="meta"><div class="small">${escapeHtml(
      m.sender_name
    )}</div><div class="time">${formatTime(m.created_at)}</div></div>`;
    row.appendChild(avatar);
    row.appendChild(bubble);
    chatWindow.appendChild(row);
    chatWindow.scrollTop = chatWindow.scrollHeight;
  }

  function escapeHtml(str) {
    if (!str) return "";
    return str.replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
    );
  }
  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  // load last messages
  const msgsRes = await fetch("/api/messages", {
    headers: { Authorization: "Bearer " + token },
  });
  if (msgsRes.ok) {
    const messages = await msgsRes.json();
    messages.forEach(renderMessage);
  }

  // socket handlers
  socket.on("connect_error", (err) => {
    console.error("Socket error", err);
    if (err && err.message === "Auth error") {
      localStorage.removeItem("CHAT_TOKEN");
      location.href = "../html/login.html";
    }
  });

  socket.on("new_message", (m) => {
    renderMessage(m);
  });

  // send message
  document.getElementById("sendBtn").onclick = send;
  document.getElementById("messageInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") send();
  });

  function send() {
    const input = document.getElementById("messageInput");
    const text = input.value.trim();
    if (!text) return;
    socket.emit("send_message", {
      content: text,
      anonymous: anonymousMode,
    });
    input.value = "";
  }
})();
