(function () {
    var logoutButton = document.getElementById('logout-button');
    var form = document.getElementById('journal-entry-form');
    var confidenceInput = document.getElementById('confidence');
    var confidenceValue = document.getElementById('confidence-value');
    var messageNode = document.getElementById('journal-message');
    var tradeImageInput = document.getElementById('trade-image');
    var tradeImagePreviewWrap = document.getElementById('trade-image-preview-wrap');
    var tradeImagePreview = document.getElementById('trade-image-preview');
    var MAX_IMAGE_BYTES = 5 * 1024 * 1024;
    var SUPPORTED_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

    if (!form) {
        return;
    }

    function setText(id, value) {
        var node = document.getElementById(id);

        if (node) {
            node.textContent = value;
        }
    }

    function setMessage(text, type) {
        messageNode.textContent = text;
        messageNode.className = 'form-message';

        if (type === 'error') {
            messageNode.classList.add('is-error');
        }

        if (type === 'success') {
            messageNode.classList.add('is-success');
        }
    }

    function formatCurrency(value) {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD'
        }).format(value);
    }

    function formatDate(value) {
        if (!value) {
            return '--';
        }

        var date = new Date(value + 'T00:00:00');

        if (Number.isNaN(date.getTime())) {
            return value;
        }

        return new Intl.DateTimeFormat('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        }).format(date);
    }

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function clearImagePreview() {
        if (tradeImagePreview) {
            tradeImagePreview.removeAttribute('src');
        }

        if (tradeImagePreviewWrap) {
            tradeImagePreviewWrap.classList.add('hidden');
        }
    }

    function setImagePreview(dataUrl) {
        if (!tradeImagePreview || !tradeImagePreviewWrap) {
            return;
        }

        tradeImagePreview.src = dataUrl;
        tradeImagePreviewWrap.classList.remove('hidden');
    }

    function fileToDataUrl(file) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();

            reader.onload = function () {
                resolve(String(reader.result || ''));
            };

            reader.onerror = function () {
                reject(new Error('Could not read image file.'));
            };

            reader.readAsDataURL(file);
        });
    }

    async function uploadTradeImage(file) {
        var imageDataUrl = await fileToDataUrl(file);
        var uploadData = await fetchJson('/api/journal/upload-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageDataUrl: imageDataUrl })
        });

        return uploadData.imageFile || '';
    }

    async function fetchJson(url, options) {
        var response = await fetch(url, options);
        var data = await response.json().catch(function () {
            return null;
        });

        if (!response.ok) {
            throw new Error(data && data.error ? data.error : 'Request failed.');
        }

        return data;
    }

    function updateSummary(stats) {
        var totalTrades = Number(stats.totalTrades || 0);
        var winRate = Number(stats.winRate || 0);
        var totalPnl = Number(stats.totalPnl || 0);

        setText('summary-total', String(totalTrades));
        setText('summary-win-rate', String(winRate) + '%');
        setText('summary-pnl', formatCurrency(totalPnl));

        var pnlNode = document.getElementById('summary-pnl');

        if (pnlNode) {
            pnlNode.classList.remove('text-positive', 'text-negative');

            if (totalPnl > 0) {
                pnlNode.classList.add('text-positive');
            } else if (totalPnl < 0) {
                pnlNode.classList.add('text-negative');
            }
        }
    }

    function renderEntries(entries) {
        var tbody = document.getElementById('entries-body');

        if (!tbody) {
            return;
        }

        if (!entries.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty-row">No entries yet. Add your first trade.</td></tr>';
            return;
        }

        tbody.innerHTML = entries.map(function (entry) {
            var pnl = Number(entry.pnl || 0);
            var pnlClass = pnl > 0 ? 'text-positive' : (pnl < 0 ? 'text-negative' : '');
            var resultClass = entry.result === 'win' ? 'badge badge-win' : 'badge badge-loss';
            var symbol = entry.symbol ? escapeHtml(entry.symbol) : '--';
            var screenshotFile = String(entry.screenshotFile || '').trim();
            var imageCell = '--';

            if (screenshotFile) {
                var imageUrl = '/api/journal/images/' + encodeURIComponent(screenshotFile);
                imageCell = (
                    '<a class="entry-image-link" href="' + imageUrl + '" target="_blank" rel="noopener noreferrer">' +
                    '<img class="entry-image-thumb" src="' + imageUrl + '" alt="Trade screenshot">' +
                    '</a>'
                );
            }

            return [
                '<tr>',
                '<td>' + escapeHtml(formatDate(entry.tradeDate)) + '</td>',
                '<td>' + symbol + '</td>',
                '<td>' + escapeHtml(entry.setup || '--') + '</td>',
                '<td><span class="' + resultClass + '">' + escapeHtml(entry.result || '--') + '</span></td>',
                '<td class="' + pnlClass + '">' + escapeHtml(formatCurrency(pnl)) + '</td>',
                '<td>' + escapeHtml(String(entry.confidence || '--')) + '/10</td>',
                '<td>' + imageCell + '</td>',
                '</tr>'
            ].join('');
        }).join('');
    }

    async function loadSession() {
        var data = await fetchJson('/api/auth/session');

        if (!data.loggedIn || !data.user) {
            window.location.href = '/#signup';
            return;
        }

        setText('user-email', data.user.email || '-');
    }

    async function loadEntries() {
        var data = await fetchJson('/api/journal/entries');
        renderEntries(data.entries || []);
        updateSummary(data.stats || {});
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

    function validatePayload(payload) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.tradeDate)) {
            return 'Please enter a valid trade date.';
        }

        if (payload.symbol.length > 12) {
            return 'Symbol must be 12 characters or fewer.';
        }

        if (payload.setup.length < 2) {
            return 'Please choose or enter a setup.';
        }

        if (!['win', 'loss'].includes(payload.result)) {
            return 'Please choose a valid result.';
        }

        if (!Number.isFinite(payload.pnl)) {
            return 'Please enter a valid P&L value.';
        }

        if (!Number.isInteger(payload.confidence) || payload.confidence < 1 || payload.confidence > 10) {
            return 'Confidence must be between 1 and 10.';
        }

        if (payload.notes.length > 1000) {
            return 'Notes must be 1000 characters or fewer.';
        }

        return '';
    }

    form.addEventListener('submit', async function (event) {
        event.preventDefault();
        setMessage('', '');

        var payload = {
            tradeDate: document.getElementById('trade-date').value,
            symbol: document.getElementById('symbol').value.trim().toUpperCase(),
            setup: document.getElementById('setup').value.trim(),
            result: document.getElementById('result').value.trim().toLowerCase(),
            pnl: Number(document.getElementById('pnl').value),
            confidence: Number(document.getElementById('confidence').value),
            notes: document.getElementById('notes').value.trim(),
            screenshotFile: ''
        };
        var imageFile = tradeImageInput && tradeImageInput.files ? tradeImageInput.files[0] : null;

        var validationError = validatePayload(payload);

        if (validationError) {
            setMessage(validationError, 'error');
            return;
        }

        if (imageFile) {
            if (!SUPPORTED_IMAGE_MIMES.includes(imageFile.type)) {
                setMessage('Only PNG, JPG, WEBP, or GIF images are supported.', 'error');
                return;
            }

            if (imageFile.size > MAX_IMAGE_BYTES) {
                setMessage('Image must be 5MB or smaller.', 'error');
                return;
            }
        }

        try {
            if (imageFile) {
                setMessage('Uploading screenshot...', '');
                payload.screenshotFile = await uploadTradeImage(imageFile);
            }

            await fetchJson('/api/journal/entries', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            setMessage('Trade entry saved.', 'success');
            form.reset();
            document.getElementById('trade-date').valueAsDate = new Date();
            document.getElementById('confidence').value = '5';
            setText('confidence-value', '5');
            clearImagePreview();
            await loadEntries();
        } catch (error) {
            setMessage(error.message, 'error');
        }
    });

    if (confidenceInput) {
        confidenceInput.addEventListener('input', function () {
            setText('confidence-value', confidenceInput.value);
        });
    }

    if (tradeImageInput) {
        tradeImageInput.addEventListener('change', async function () {
            var file = tradeImageInput.files ? tradeImageInput.files[0] : null;

            if (!file) {
                clearImagePreview();
                return;
            }

            if (!SUPPORTED_IMAGE_MIMES.includes(file.type)) {
                setMessage('Only PNG, JPG, WEBP, or GIF images are supported.', 'error');
                tradeImageInput.value = '';
                clearImagePreview();
                return;
            }

            if (file.size > MAX_IMAGE_BYTES) {
                setMessage('Image must be 5MB or smaller.', 'error');
                tradeImageInput.value = '';
                clearImagePreview();
                return;
            }

            try {
                var dataUrl = await fileToDataUrl(file);
                setImagePreview(dataUrl);
            } catch (error) {
                setMessage(error.message, 'error');
                tradeImageInput.value = '';
                clearImagePreview();
            }
        });
    }

    if (logoutButton) {
        logoutButton.addEventListener('click', logout);
    }

    document.getElementById('trade-date').valueAsDate = new Date();

    Promise.all([loadSession(), loadEntries()]).catch(function (error) {
        console.error(error);
        window.location.href = '/#signup';
    });
})();
