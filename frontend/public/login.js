(function () {
  var $ = function (id) { return document.getElementById(id); };
  var API = window.JOBDO_API || '';
  var mode = 'login';

  function setMode(next) {
    mode = next;
    var isLogin = mode === 'login';
    $('heading').textContent = isLogin ? 'Sign in' : 'Create an account';
    $('sub').textContent = isLogin
      ? 'Your application history and resumes, wherever you are.'
      : 'One account per person. This server is yours.';
    $('submit').textContent = isLogin ? 'Sign in' : 'Create account';
    $('swapText').textContent = isLogin ? 'No account yet?' : 'Already have an account?';
    $('swap').textContent = isLogin ? 'Create one' : 'Sign in';
    $('pwHint').hidden = isLogin;
    $('forgot').hidden = !isLogin;
    $('password').setAttribute('autocomplete', isLogin ? 'current-password' : 'new-password');
    hideMessage();
  }

  function message(text, kind) {
    var el = $('error');
    el.textContent = text;
    el.className = kind === 'ok' ? 'notice' : 'error';
    el.hidden = false;
    $('resend').hidden = true;
  }

  // An unconfirmed account is the one failure the person can fix from here, so
  // it gets an action rather than just a sentence.
  function needsConfirmation(text, email) {
    message(text);
    var btn = $('resend');
    btn.hidden = false;
    btn.disabled = false;
    btn.onclick = function () {
      btn.disabled = true;
      post('resend-confirmation', { email: email, redirectTo: location.origin + '/' })
        .then(function (res) { message(res.data.message || 'Sent.', 'ok'); })
        .catch(function () { message('Could not reach the server.'); });
    };
  }

  function hideMessage() { $('error').hidden = true; $('resend').hidden = true; }

  function post(path, body) {
    return fetch(API + '/api/auth/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',           // the session lives in HttpOnly cookies
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, ok: res.ok, data: data };
      });
    });
  }

  $('swap').onclick = function () { setMode(mode === 'login' ? 'register' : 'login'); };

  $('forgot').onclick = function () {
    var email = $('email').value.trim();
    if (!email) return message('Enter your email address first.');
    post('reset-password', { email: email, redirectTo: location.origin + '/' })
      .then(function (res) { message(res.data.message || 'Check your email.', 'ok'); })
      .catch(function () { message('Could not reach the server.'); });
  };

  $('form').addEventListener('submit', function (e) {
    e.preventDefault();
    hideMessage();
    var email = $('email').value.trim();
    var password = $('password').value;
    if (!email || !password) return message('Enter your email and password.');
    if (mode === 'register' && password.length < 10) {
      return message('Password must be at least 10 characters.');
    }

    $('submit').disabled = true;
    post(mode, { email: email, password: password, client: 'web' })
      .then(function (res) {
        if (res.status === 202) {           // email confirmation is switched on
          message(res.data.message, 'ok');
          setMode('login');
          return;
        }
        if (res.status === 403 && res.data.needsConfirmation) {
          return needsConfirmation(res.data.error, res.data.email || email);
        }
        if (!res.ok) throw new Error(res.data.error || 'Could not sign in.');
        var params = new URLSearchParams(location.search);
        var next = params.get('next');
        // Only ever follow a same-site path; an absolute URL here would be an
        // open redirect.
        location.href = (next && /^\/[^/\\]/.test(next)) ? next : 'app/';
      })
      .catch(function (err) { message(err.message); })
      .then(function () { $('submit').disabled = false; });
  });

  setMode('login');
})();
