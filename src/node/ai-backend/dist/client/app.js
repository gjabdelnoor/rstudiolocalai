/*
 * RStudio AI chat client.
 *
 * Connects to the backend WebSocket and drives a simple streaming chat UI.
 * The WebSocket URL and per-session auth token are provided by RStudio via
 * the iframe URL hash (#ws=...&token=...). When the page is served directly
 * by the backend (standalone / testing), both are derived from the location.
 */
(function () {
   'use strict';

   // --- Theme ------------------------------------------------------------
   (function applyTheme() {
      var meta = document.querySelector('meta[name="rstudio-theme"]');
      if (!meta) return;
      var bg = meta.getAttribute('data-background');
      var fg = meta.getAttribute('data-foreground');
      if (bg) document.documentElement.style.setProperty('--bg', bg);
      if (fg) document.documentElement.style.setProperty('--fg', fg);
   })();

   // --- Parameter discovery (hash first, then query string) --------------
   function readParams() {
      var params = {};
      function merge(str) {
         if (!str) return;
         if (str[0] === '#' || str[0] === '?') str = str.slice(1);
         str.split('&').forEach(function (pair) {
            if (!pair) return;
            var idx = pair.indexOf('=');
            var k = idx === -1 ? pair : pair.slice(0, idx);
            var v = idx === -1 ? '' : decodeURIComponent(pair.slice(idx + 1));
            params[k] = v;
         });
      }
      merge(window.location.hash);
      merge(window.location.search);
      return params;
   }

   // RStudio (ChatPresenter) passes the backend WebSocket base URL as the
   // "wsUrl" query param and, in Desktop mode, the auth token as "authToken".
   // In Server mode the token arrives via an httpOnly cookie that the browser
   // sends automatically on the WebSocket handshake (not readable from JS).
   // "ws"/"token" and same-origin derivation are accepted for standalone use.
   function resolveWsBase(params) {
      var raw = params.wsUrl || params.ws || '';
      var proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      var base;
      if (/^wss?:\/\//i.test(raw)) {
         base = raw;                                   // absolute (Desktop)
      } else if (raw) {
         if (raw.charAt(0) !== '/') raw = '/' + raw;   // relative path (Server)
         base = proto + '//' + window.location.host + raw;
      } else {
         base = proto + '//' + window.location.host + '/ai-chat'; // standalone
      }
      // The WebSocket endpoint lives at <base>/ws.
      return /\/ws$/.test(base) ? base : (base.replace(/\/$/, '') + '/ws');
   }

   var PARAMS = readParams();
   // Empty in Server mode -- the httpOnly cookie authenticates the handshake.
   var TOKEN = PARAMS.authToken || PARAMS.token || '';
   var WS_BASE = resolveWsBase(PARAMS);

   function wsUrlWithToken() {
      if (!TOKEN) return WS_BASE;
      return WS_BASE + (WS_BASE.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(TOKEN);
   }

   // --- DOM refs ---------------------------------------------------------
   var elMessages = document.getElementById('messages');
   var elInput = document.getElementById('input');
   var elSend = document.getElementById('send');
   var elStop = document.getElementById('stop');
   var elComposer = document.getElementById('composer');
   var elStatusDot = document.getElementById('status-dot');
   var elStatusText = document.getElementById('status-text');
   var elModelName = document.getElementById('model-name');
   var elNotConfigured = document.getElementById('not-configured');

   // --- State ------------------------------------------------------------
   var ws = null;
   var connected = false;
   var configured = false;
   var settings = {};
   var history = [];          // [{role, content}]
   var activeRequestId = null;
   var activeAssistant = null; // { contentText, thinkingText, contentEl, thinkingBodyEl }
   var reconnectDelay = 1000;

   // --- Minimal, safe Markdown rendering ---------------------------------
   function escapeHtml(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
   }

   function renderInline(text) {
      // text is already HTML-escaped.
      text = text.replace(/`([^`]+)`/g, function (_, c) { return '<code>' + c + '</code>'; });
      text = text.replace(/\*\*([^*]+)\*\*/g, function (_, c) { return '<strong>' + c + '</strong>'; });
      text = text.replace(/\b_([^_]+)_\b/g, function (_, c) { return '<em>' + c + '</em>'; });
      return text;
   }

   function renderMarkdown(text) {
      var parts = text.split(/```/);
      var html = '';
      for (var i = 0; i < parts.length; i++) {
         if (i % 2 === 1) {
            // Code block. First line may be a language hint.
            var block = parts[i];
            var nl = block.indexOf('\n');
            if (nl !== -1 && /^[a-zA-Z0-9_+-]*$/.test(block.slice(0, nl).trim())) {
               block = block.slice(nl + 1);
            }
            html += '<pre><code>' + escapeHtml(block.replace(/\n$/, '')) + '</code></pre>';
         } else {
            var paras = escapeHtml(parts[i]).split(/\n{2,}/);
            for (var p = 0; p < paras.length; p++) {
               if (!paras[p].trim()) continue;
               html += '<p>' + renderInline(paras[p]).replace(/\n/g, '<br>') + '</p>';
            }
         }
      }
      return html;
   }

   // --- Message DOM helpers ---------------------------------------------
   function scrollToBottom() { elMessages.scrollTop = elMessages.scrollHeight; }

   function addMessage(role, opts) {
      opts = opts || {};
      var msg = document.createElement('div');
      msg.className = 'msg ' + role + (opts.error ? ' error' : '');

      var roleEl = document.createElement('div');
      roleEl.className = 'role';
      roleEl.textContent = opts.error ? 'error' : role;
      msg.appendChild(roleEl);

      var refs = { msg: msg };

      if (role === 'assistant') {
         var thinking = document.createElement('details');
         thinking.className = 'thinking hidden' + (settings.interleavedThinking ? ' interleaved' : '');
         if (settings.interleavedThinking) thinking.open = true;
         var summary = document.createElement('summary');
         summary.textContent = 'Reasoning';
         var thinkingBody = document.createElement('div');
         thinkingBody.className = 'thinking-body';
         thinking.appendChild(summary);
         thinking.appendChild(thinkingBody);
         msg.appendChild(thinking);
         refs.thinkingEl = thinking;
         refs.thinkingBodyEl = thinkingBody;
      }

      var bubble = document.createElement('div');
      bubble.className = 'bubble';
      msg.appendChild(bubble);
      refs.bubble = bubble;

      if (opts.text) {
         if (opts.error) bubble.textContent = opts.text;
         else bubble.innerHTML = renderMarkdown(opts.text);
      }

      elMessages.appendChild(msg);
      scrollToBottom();
      return refs;
   }

   // --- Connection status ------------------------------------------------
   function setStatus(state, text) {
      elStatusDot.className = state;
      elStatusText.textContent = text;
   }

   function updateConfiguredUI() {
      if (configured) {
         elNotConfigured.classList.add('hidden');
         elComposer.classList.remove('hidden');
         elMessages.classList.remove('hidden');
      } else {
         elNotConfigured.classList.remove('hidden');
         elComposer.classList.add('hidden');
         elMessages.classList.add('hidden');
      }
   }

   // --- WebSocket --------------------------------------------------------
   function connect() {
      setStatus('disconnected', 'Connecting...');
      try {
         ws = new WebSocket(wsUrlWithToken());
      } catch (e) {
         setStatus('disconnected', 'Connection failed');
         scheduleReconnect();
         return;
      }

      ws.onopen = function () {
         connected = true;
         reconnectDelay = 1000;
         setStatus('connected', 'Connected');
      };

      ws.onmessage = function (ev) {
         var msg;
         try { msg = JSON.parse(ev.data); } catch (e) { return; }
         handleServerMessage(msg);
      };

      ws.onclose = function () {
         connected = false;
         setStatus('disconnected', 'Disconnected');
         finishActive();
         scheduleReconnect();
      };

      ws.onerror = function () { /* onclose will follow */ };
   }

   function scheduleReconnect() {
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
   }

   function handleServerMessage(msg) {
      switch (msg.type) {
         case 'ready':
            configured = !!msg.configured;
            settings = msg;
            elModelName.textContent = msg.model ? (msg.model) : '';
            updateConfiguredUI();
            break;
         case 'thinking':
            if (activeAssistant) appendThinking(msg.content);
            break;
         case 'delta':
            if (activeAssistant) appendDelta(msg.content);
            break;
         case 'done':
            commitActive();
            break;
         case 'error':
            handleError(msg.message);
            break;
      }
   }

   function appendThinking(text) {
      activeAssistant.thinkingText += text;
      activeAssistant.thinkingBodyEl.textContent = activeAssistant.thinkingText;
      activeAssistant.thinkingEl.classList.remove('hidden');
      scrollToBottom();
   }

   function appendDelta(text) {
      activeAssistant.contentText += text;
      activeAssistant.bubble.innerHTML = renderMarkdown(activeAssistant.contentText);
      scrollToBottom();
   }

   function commitActive() {
      if (!activeAssistant) return;
      if (activeAssistant.contentText) {
         history.push({ role: 'assistant', content: activeAssistant.contentText });
      }
      finishActive();
   }

   function finishActive() {
      activeRequestId = null;
      activeAssistant = null;
      elStop.classList.add('hidden');
      elSend.disabled = false;
      elInput.disabled = false;
   }

   function handleError(message) {
      if (activeAssistant && !activeAssistant.contentText && !activeAssistant.thinkingText) {
         activeAssistant.msg.remove();
      }
      addMessage('assistant', { error: true, text: message || 'Unknown error' });
      finishActive();
   }

   // --- Sending ----------------------------------------------------------
   function sendMessage() {
      var text = elInput.value.trim();
      if (!text || !connected || activeRequestId) return;

      addMessage('user', { text: text });
      history.push({ role: 'user', content: text });

      elInput.value = '';
      autoGrow();

      activeRequestId = 'r' + Date.now();
      var refs = addMessage('assistant', {});
      activeAssistant = {
         contentText: '',
         thinkingText: '',
         bubble: refs.bubble,
         msg: refs.msg,
         thinkingEl: refs.thinkingEl,
         thinkingBodyEl: refs.thinkingBodyEl
      };

      elSend.disabled = true;
      elStop.classList.remove('hidden');

      ws.send(JSON.stringify({
         type: 'chat',
         requestId: activeRequestId,
         messages: history
      }));
   }

   function stopGeneration() {
      // The backend aborts the upstream request when the socket closes; for an
      // explicit stop we simply finalize what we have and reconnect.
      if (ws) try { ws.close(); } catch (e) { /* ignore */ }
      commitActive();
   }

   // --- Input behaviour --------------------------------------------------
   function autoGrow() {
      elInput.style.height = 'auto';
      elInput.style.height = Math.min(elInput.scrollHeight, 160) + 'px';
   }

   elInput.addEventListener('input', autoGrow);
   elInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
         e.preventDefault();
         sendMessage();
      }
   });
   elComposer.addEventListener('submit', function (e) { e.preventDefault(); sendMessage(); });
   elStop.addEventListener('click', stopGeneration);

   // --- Go ---------------------------------------------------------------
   updateConfiguredUI();
   connect();
})();
