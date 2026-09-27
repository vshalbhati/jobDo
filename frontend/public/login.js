(function () {
  var $ = function (id) { return document.getElementById(id); };
  var API = window.JOBDO_API || '';
  var mode = 'login';
  var pendingEmail = '';     // the address waiting on its confirmation code
  var cooldown = null;

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
  }

  function hideMessage() { $('error').hidden = true; }

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

  function goToApp() {
    var params = new URLSearchParams(location.search);
    var next = params.get('next');
    // Only ever follow a same-site path; an absolute URL here would be an
    // open redirect.
    location.href = (next && /^\/[^/\\]/.test(next)) ? next : 'app/';
  }

  // ------------------------------------------------ the emailed code (step 2)

  function showVerify(email, text) {
    pendingEmail = email;
    $('form').hidden = true;
    $('swapRow').hidden = true;
    $('verifyForm').hidden = false;
    $('heading').textContent = 'Check your email';
    $('sub').textContent = text || ('We sent a code to ' + email + '. Enter it to finish creating your account.');
    $('verifyMsg').hidden = true;
    $('code').value = '';
    $('code').focus();
  }

  function hideVerify() {
    pendingEmail = '';
    $('verifyForm').hidden = true;
    $('form').hidden = false;
    $('swapRow').hidden = false;
  }

  function verifyMessage(text, kind) {
    var el = $('verifyMsg');
    el.textContent = text;
    el.className = kind === 'ok' ? 'notice' : 'error';
    el.hidden = false;
  }

  // Supabase sends at most one code a minute; the button says when it can again.
  function startCooldown(seconds) {
    var btn = $('resendCode');
    clearInterval(cooldown);
    var left = seconds;
    btn.disabled = true;
    btn.textContent = 'Send a new code (' + left + 's)';
    cooldown = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        clearInterval(cooldown);
        btn.disabled = false;
        btn.textContent = 'Send a new code';
        return;
      }
      btn.textContent = 'Send a new code (' + left + 's)';
    }, 1000);
  }

  // Digits only, as they are typed or pasted ("123 456" from an email works).
  $('code').addEventListener('input', function () {
    var digits = this.value.replace(/\D+/g, '').slice(0, 10);
    if (digits !== this.value) this.value = digits;
  });

  $('verifyForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var code = $('code').value.replace(/\D+/g, '');
    if (code.length < 6) return verifyMessage('Enter the code from the email: it is 6 digits.');
    $('verifySubmit').disabled = true;
    post('verify', { email: pendingEmail, code: code, client: 'web' })
      .then(function (res) {
        if (!res.ok) throw new Error(res.data.error || 'That code did not work.');
        goToApp();
      })
      .catch(function (err) { verifyMessage(err.message); })
      .then(function () { $('verifySubmit').disabled = false; });
  });

  $('resendCode').onclick = function () {
    startCooldown(60);
    post('resend-confirmation', { email: pendingEmail })
      .then(function (res) { verifyMessage(res.data.message || 'A new code is on its way.', 'ok'); })
      .catch(function () { verifyMessage('Could not reach the server.'); });
  };

  $('changeEmail').onclick = function () {
    hideVerify();
    setMode('register');
    $('email').focus();
  };

  // ---------------------------------------------------- sign in / sign up

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
        if (res.status === 202) {           // a code is on its way
          showVerify(res.data.email || email, res.data.message);
          startCooldown(60);
          return;
        }
        // An unconfirmed account is the one failure the person can fix from
        // here: the code step, with the option of a new code.
        if (res.status === 403 && res.data.needsConfirmation) {
          showVerify(res.data.email || email, res.data.error);
          return;
        }
        if (!res.ok) throw new Error(res.data.error || 'Could not sign in.');
        goToApp();
      })
      .catch(function (err) { message(err.message); })
      .then(function () { $('submit').disabled = false; });
  });

  setMode('login');
})();
