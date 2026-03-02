(function () {
    var logoutButton = document.getElementById('logout-button');
    var navLinks = Array.from(document.querySelectorAll('[data-nav-link]'));

    function setText(id, value) {
        var node = document.getElementById(id);

        if (node) {
            node.textContent = value;
        }
    }

    function setClassByValue(nodeId, value) {
        var node = document.getElementById(nodeId);

        if (!node) {
            return;
        }

        node.classList.remove('text-positive', 'text-negative');

        if (value > 0) {
            node.classList.add('text-positive');
        } else if (value < 0) {
            node.classList.add('text-negative');
        }
    }

    function formatCurrency(value) {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD'
        }).format(value);
    }

    function formatDate(isoDateString) {
        if (!isoDateString) {
            return '-';
        }

        var date = new Date(isoDateString);

        if (Number.isNaN(date.getTime())) {
            return '-';
        }

        return new Intl.DateTimeFormat('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        }).format(date);
    }

    async function fetchJson(url, options) {
        var response = await fetch(url, options);
        var data = await response.json().catch(function () {
            return null;
        });

        if (!response.ok) {
            var errorMessage = data && data.error ? data.error : 'Request failed.';
            throw new Error(errorMessage);
        }

        return data;
    }

    function updateNavState(sectionId) {
        navLinks.forEach(function (link) {
            var target = link.getAttribute('href');
            var isActive = target === '#' + sectionId;
            link.classList.toggle('is-active', isActive);
        });
    }

    function initNav() {
        navLinks.forEach(function (link) {
            link.addEventListener('click', function () {
                var targetId = (link.getAttribute('href') || '').replace('#', '');

                if (targetId) {
                    updateNavState(targetId);
                }
            });
        });

        var sections = Array.from(document.querySelectorAll('section[id]'));

        if (!sections.length || typeof IntersectionObserver === 'undefined') {
            return;
        }

        var observer = new IntersectionObserver(
            function (entries) {
                entries.forEach(function (entry) {
                    if (entry.isIntersecting) {
                        updateNavState(entry.target.id);
                    }
                });
            },
            {
                root: null,
                threshold: 0.35
            }
        );

        sections.forEach(function (section) {
            observer.observe(section);
        });
    }

    async function loadSession() {
        var data = await fetchJson('/api/auth/session');

        if (!data.loggedIn || !data.user) {
            window.location.href = '/#signup';
            return null;
        }

        var user = data.user;

        setText('user-name', user.fullName || 'Trader');
        setText('user-email', user.email || '');
        setText('nav-user-email', user.email || '-');
        setText('account-name', user.fullName || '-');
        setText('account-email', user.email || '-');
        setText('account-created', formatDate(user.createdAt));

        return user;
    }

    function updateAnalytics(stats) {
        var winRate = Number(stats.winRate || 0);
        var totalPnl = Number(stats.totalPnl || 0);

        setText('win-rate-text', String(winRate) + '%');

        var meter = document.getElementById('win-rate-meter');

        if (meter) {
            var bounded = Math.max(0, Math.min(100, winRate));
            meter.style.width = String(bounded) + '%';
        }

        if (totalPnl > 0) {
            setText('pnl-health', 'Positive performance trend. Keep repeating your highest-quality setups.');
        } else if (totalPnl < 0) {
            setText('pnl-health', 'Negative P&L trend. Review loss clusters and tighten your risk rules.');
        } else {
            setText('pnl-health', 'No P&L history yet. Start logging trades.');
        }
    }

    async function loadStats() {
        var data = await fetchJson('/api/dashboard/data');
        var stats = data.stats || {};

        var totalTrades = Number(stats.totalTrades || 0);
        var winRate = Number(stats.winRate || 0);
        var totalPnl = Number(stats.totalPnl || 0);

        setText('stat-total-trades', String(totalTrades));
        setText('stat-win-rate', String(winRate) + '%');
        setText('stat-total-pnl', formatCurrency(totalPnl));

        setClassByValue('stat-total-pnl', totalPnl);
        updateAnalytics(stats);
    }

    async function logout() {
        try {
            await fetchJson('/api/auth/logout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
        } finally {
            window.location.href = '/';
        }
    }

    if (logoutButton) {
        logoutButton.addEventListener('click', logout);
    }

    initNav();

    Promise.all([loadSession(), loadStats()]).catch(function (error) {
        console.error(error);
        window.location.href = '/#signup';
    });
})();
