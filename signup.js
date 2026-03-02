(function () {
    var signupForm = document.getElementById('signup-form');
    var loginForm = document.getElementById('login-form');

    if (!signupForm || !loginForm) {
        return;
    }

    var fullNameInput = document.getElementById('full-name');
    var emailInput = document.getElementById('email');
    var passwordInput = document.getElementById('password');
    var confirmPasswordInput = document.getElementById('confirm-password');
    var agreeTermsInput = document.getElementById('agree-terms');
    var loginEmailInput = document.getElementById('login-email');
    var loginPasswordInput = document.getElementById('login-password');
    var signupMessage = document.getElementById('signup-message');
    var loginMessage = document.getElementById('login-message');

    function setMessage(node, text, type) {
        node.textContent = text;
        node.className = 'form-message';

        if (type === 'error') {
            node.classList.add('is-error');
        }

        if (type === 'success') {
            node.classList.add('is-success');
        }
    }

    function isValidEmail(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }

    function isStrongPassword(password) {
        return password.length >= 8 && /[A-Za-z]/.test(password) && /[0-9]/.test(password);
    }

    function showOAuthErrorFromQuery() {
        var params = new URLSearchParams(window.location.search);
        var authError = params.get('auth_error');

        if (!authError) {
            return;
        }

        setMessage(signupMessage, authError, 'error');
        params.delete('auth_error');

        var nextQuery = params.toString();
        var nextUrl = window.location.pathname + (nextQuery ? '?' + nextQuery : '') + window.location.hash;
        window.history.replaceState({}, '', nextUrl);
    }

    async function postJson(url, payload) {
        var response;

        try {
            response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        } catch {
            throw new Error('Cannot connect to the server. Start the app with "npm start" and open http://localhost:3000');
        }

        var contentType = String(response.headers.get('content-type') || '').toLowerCase();
        var data = null;
        var text = '';

        if (contentType.indexOf('application/json') !== -1) {
            data = await response.json().catch(function () {
                return null;
            });
        } else {
            text = await response.text().catch(function () {
                return '';
            });
        }

        if (!response.ok) {
            if (data && data.error) {
                throw new Error(data.error);
            }

            if (response.status === 404) {
                throw new Error('Auth API not found. Open the app at http://localhost:3000 (not a file preview server).');
            }

            if (response.status >= 500) {
                throw new Error('Server error while creating account. Please try again.');
            }

            throw new Error(text || 'Request failed.');
        }

        return data || {};
    }

    async function checkExistingSession() {
        try {
            var response = await fetch('/api/auth/session');
            var data = await response.json();

            if (data.loggedIn && data.user) {
                setMessage(
                    signupMessage,
                    'You are already signed in as ' + data.user.email + '. Redirecting to dashboard...',
                    'success'
                );

                setTimeout(function () {
                    window.location.href = '/dashboard';
                }, 700);
            }
        } catch (error) {
            console.error(error);
            setMessage(signupMessage, 'Server connection check failed. Make sure the app is running at http://localhost:3000', 'error');
        }
    }

    signupForm.addEventListener('submit', async function (event) {
        event.preventDefault();
        setMessage(signupMessage, '', '');

        var payload = {
            fullName: fullNameInput.value.trim(),
            email: emailInput.value.trim(),
            password: passwordInput.value,
            confirmPassword: confirmPasswordInput.value,
            agreeTerms: agreeTermsInput.checked
        };

        if (payload.fullName.length < 2) {
            setMessage(signupMessage, 'Please enter your full name.', 'error');
            return;
        }

        if (!isValidEmail(payload.email)) {
            setMessage(signupMessage, 'Please enter a valid email address.', 'error');
            return;
        }

        if (!isStrongPassword(payload.password)) {
            setMessage(signupMessage, 'Password must be at least 8 characters with letters and numbers.', 'error');
            return;
        }

        if (payload.password !== payload.confirmPassword) {
            setMessage(signupMessage, 'Password and confirmation must match.', 'error');
            return;
        }

        if (!payload.agreeTerms) {
            setMessage(signupMessage, 'Please agree to the Terms and Privacy Policy.', 'error');
            return;
        }

        try {
            var data = await postJson('/api/auth/signup', payload);
            setMessage(signupMessage, 'Account created successfully. Redirecting...', 'success');

            setTimeout(function () {
                window.location.href = data.redirect || '/dashboard';
            }, 300);
        } catch (error) {
            setMessage(signupMessage, error.message, 'error');
        }
    });

    loginForm.addEventListener('submit', async function (event) {
        event.preventDefault();
        setMessage(loginMessage, '', '');

        var payload = {
            email: loginEmailInput.value.trim(),
            password: loginPasswordInput.value
        };

        if (!isValidEmail(payload.email)) {
            setMessage(loginMessage, 'Please enter a valid email address.', 'error');
            return;
        }

        if (!payload.password) {
            setMessage(loginMessage, 'Please enter your password.', 'error');
            return;
        }

        try {
            var data = await postJson('/api/auth/login', payload);
            setMessage(loginMessage, 'Login successful. Redirecting...', 'success');

            setTimeout(function () {
                window.location.href = data.redirect || '/dashboard';
            }, 300);
        } catch (error) {
            setMessage(loginMessage, error.message, 'error');
        }
    });

    showOAuthErrorFromQuery();
    checkExistingSession();
})();
