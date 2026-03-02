(function () {
    var logoutButton = document.getElementById('logout-button');
    var monthLabel = document.getElementById('month-label');
    var grid = document.getElementById('calendar-grid');
    var selectedDateLabel = document.getElementById('selected-date-label');
    var selectedDateSummary = document.getElementById('selected-date-summary');
    var dayEntriesContainer = document.getElementById('day-entries');
    var monthTotalPnlNode = document.getElementById('month-total-pnl');
    var prevMonthButton = document.getElementById('prev-month');
    var nextMonthButton = document.getElementById('next-month');
    var todayButton = document.getElementById('today-btn');
    var togglePnlButton = document.getElementById('toggle-pnl');
    var toggleWinrateButton = document.getElementById('toggle-winrate');

    var state = {
        currentMonth: toMonthKey(new Date()),
        selectedDate: toDateKey(new Date()),
        entries: [],
        heatmapMode: 'pnl',
        autoFollowCurrentMonth: true
    };

    function toMonthKey(date) {
        return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
    }

    function toDateKey(date) {
        return (
            date.getFullYear() + '-' +
            String(date.getMonth() + 1).padStart(2, '0') + '-' +
            String(date.getDate()).padStart(2, '0')
        );
    }

    function monthKeyToDate(monthKey) {
        var year = Number(monthKey.slice(0, 4));
        var month = Number(monthKey.slice(5, 7));
        return new Date(year, month - 1, 1);
    }

    function formatMonthLabel(monthKey) {
        var date = monthKeyToDate(monthKey);

        return new Intl.DateTimeFormat('en-US', {
            month: 'long',
            year: 'numeric'
        }).format(date);
    }

    function formatDisplayDate(dateKey) {
        if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
            return 'Select a day';
        }

        var year = Number(dateKey.slice(0, 4));
        var month = Number(dateKey.slice(5, 7));
        var day = Number(dateKey.slice(8, 10));
        var date = new Date(year, month - 1, day);

        return new Intl.DateTimeFormat('en-US', {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            year: 'numeric'
        }).format(date);
    }

    function formatCurrency(value) {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD'
        }).format(value);
    }

    function formatCompactCurrency(value) {
        var absolute = Math.abs(value);
        var sign = value > 0 ? '+' : (value < 0 ? '-' : '');

        if (absolute >= 1000) {
            return sign + '$' + (absolute / 1000).toFixed(1).replace('.0', '') + 'k';
        }

        if (absolute >= 100) {
            return sign + '$' + Math.round(absolute);
        }

        return sign + '$' + absolute.toFixed(2);
    }

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function setText(id, value) {
        var node = document.getElementById(id);

        if (node) {
            node.textContent = value;
        }
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

    function groupEntriesByDate(entries) {
        return entries.reduce(function (acc, entry) {
            var key = entry.tradeDate;

            if (!acc[key]) {
                acc[key] = [];
            }

            acc[key].push(entry);
            return acc;
        }, {});
    }

    function buildDailyMetrics(entries) {
        return entries.reduce(function (acc, entry) {
            var key = entry.tradeDate;

            if (!acc[key]) {
                acc[key] = { count: 0, pnl: 0, wins: 0 };
            }

            acc[key].count += 1;
            acc[key].pnl += Number(entry.pnl || 0);
            acc[key].wins += entry.result === 'win' ? 1 : 0;

            return acc;
        }, {});
    }

    function getHeatLevel(dayPnl, maxAbsPnl) {
        if (!maxAbsPnl || dayPnl === 0) {
            return 1;
        }

        var scaled = Math.ceil((Math.abs(dayPnl) / maxAbsPnl) * 4);
        return Math.max(1, Math.min(4, scaled));
    }

    function updateLegendTexts() {
        if (state.heatmapMode === 'winrate') {
            setText('legend-positive-text', 'High win rate day');
            setText('legend-negative-text', 'Low win rate day');
            setText('legend-neutral-text', 'Neutral / no trades');
        } else {
            setText('legend-positive-text', 'Profit day');
            setText('legend-negative-text', 'Loss day');
            setText('legend-neutral-text', 'Flat / no trades');
        }
    }

    function setHeatmapMode(mode) {
        state.heatmapMode = mode;

        if (togglePnlButton) {
            togglePnlButton.classList.toggle('is-active', mode === 'pnl');
        }

        if (toggleWinrateButton) {
            toggleWinrateButton.classList.toggle('is-active', mode === 'winrate');
        }

        updateLegendTexts();
        renderCalendar();
    }

    function updateMonthSummary() {
        var monthTotalPnl = state.entries.reduce(function (sum, entry) {
            return sum + Number(entry.pnl || 0);
        }, 0);

        if (!monthTotalPnlNode) {
            return;
        }

        monthTotalPnlNode.textContent = formatCurrency(monthTotalPnl);
        monthTotalPnlNode.classList.remove('text-positive', 'text-negative');

        if (monthTotalPnl > 0) {
            monthTotalPnlNode.classList.add('text-positive');
        } else if (monthTotalPnl < 0) {
            monthTotalPnlNode.classList.add('text-negative');
        }
    }

    async function maybeAutoAdvanceMonth() {
        if (!state.autoFollowCurrentMonth) {
            return;
        }

        var now = new Date();
        var liveMonth = toMonthKey(now);

        if (state.currentMonth === liveMonth) {
            return;
        }

        state.currentMonth = liveMonth;
        state.selectedDate = toDateKey(now);
        await loadMonthEntries();
    }

    function renderDayDetails() {
        var selectedEntries = state.entries.filter(function (entry) {
            return entry.tradeDate === state.selectedDate;
        });

        selectedDateLabel.textContent = formatDisplayDate(state.selectedDate);

        if (!selectedEntries.length) {
            selectedDateSummary.textContent = 'No entries found for this day.';
            dayEntriesContainer.innerHTML = '<p class="empty-message">No journal entries on this date.</p>';
            return;
        }

        var pnlTotal = selectedEntries.reduce(function (sum, entry) {
            return sum + Number(entry.pnl || 0);
        }, 0);

        selectedDateSummary.textContent =
            selectedEntries.length +
            ' entr' + (selectedEntries.length === 1 ? 'y' : 'ies') +
            ' for this day • Total P&L ' + formatCurrency(pnlTotal);

        dayEntriesContainer.innerHTML = selectedEntries.map(function (entry) {
            var resultClass = entry.result === 'win' ? 'badge badge-win' : 'badge badge-loss';
            var pnl = Number(entry.pnl || 0);
            var pnlClass = pnl > 0 ? 'text-positive' : (pnl < 0 ? 'text-negative' : '');

            return [
                '<article class="entry-card">',
                '  <div class="entry-top">',
                '    <div>',
                '      <p class="entry-symbol">' + escapeHtml(entry.symbol || 'N/A') + '</p>',
                '      <p class="entry-setup">' + escapeHtml(entry.setup || 'No setup') + '</p>',
                '    </div>',
                '    <span class="' + resultClass + '">' + escapeHtml(entry.result || '--') + '</span>',
                '  </div>',
                '  <p>Confidence: ' + escapeHtml(String(entry.confidence || 0)) + '/10</p>',
                '  <p class="' + pnlClass + '">P&L: ' + escapeHtml(formatCurrency(pnl)) + '</p>',
                '  <p class="entry-notes">' + escapeHtml(entry.notes || 'No notes added.') + '</p>',
                '</article>'
            ].join('');
        }).join('');
    }

    function renderCalendar() {
        var monthDate = monthKeyToDate(state.currentMonth);
        var todayKey = toDateKey(new Date());
        var firstDay = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
        var startWeekDay = firstDay.getDay();
        var daysInMonth = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate();
        var dailyMetrics = buildDailyMetrics(state.entries);
        var maxAbsPnl = Object.keys(dailyMetrics).reduce(function (max, key) {
            return Math.max(max, Math.abs(Number(dailyMetrics[key].pnl || 0)));
        }, 0);

        monthLabel.textContent = formatMonthLabel(state.currentMonth);

        var cells = [];

        for (var i = 0; i < startWeekDay; i += 1) {
            var outsideDate = new Date(monthDate.getFullYear(), monthDate.getMonth(), i - startWeekDay + 1);
            var outsideKey = toDateKey(outsideDate);
            cells.push('<button type="button" class="day-cell is-outside" data-date="' + outsideKey + '"><span class="day-number">' + outsideDate.getDate() + '</span></button>');
        }

        for (var day = 1; day <= daysInMonth; day += 1) {
            var date = new Date(monthDate.getFullYear(), monthDate.getMonth(), day);
            var dateKey = toDateKey(date);
            var metrics = dailyMetrics[dateKey] || { count: 0, pnl: 0 };
            var count = metrics.count;
            var dayPnl = Number(metrics.pnl || 0);
            var dayWins = Number(metrics.wins || 0);
            var dayWinRate = count > 0 ? (dayWins / count) * 100 : 0;
            var classes = ['day-cell'];
            var dayLabel = '';
            var dayLabelClass = '';
            var dayClass = 'is-flat-day';
            var heatLevel = 1;

            if (dateKey === state.selectedDate) {
                classes.push('is-selected');
            }

            if (dateKey === todayKey) {
                classes.push('is-today');
            }

            if (count > 0) {
                if (state.heatmapMode === 'winrate') {
                    if (dayWinRate > 55) {
                        dayClass = 'is-profit-day';
                        dayLabelClass = 'is-profit';
                    } else if (dayWinRate < 45) {
                        dayClass = 'is-loss-day';
                        dayLabelClass = 'is-loss';
                    } else {
                        dayClass = 'is-flat-day';
                    }

                    heatLevel = getHeatLevel(dayWinRate - 50, 50);
                    dayLabel = Math.round(dayWinRate) + '% win';
                } else {
                    if (dayPnl > 0) {
                        dayClass = 'is-profit-day';
                        dayLabelClass = 'is-profit';
                    } else if (dayPnl < 0) {
                        dayClass = 'is-loss-day';
                        dayLabelClass = 'is-loss';
                    } else {
                        dayClass = 'is-flat-day';
                    }

                    heatLevel = getHeatLevel(dayPnl, maxAbsPnl);
                    dayLabel = formatCompactCurrency(dayPnl);
                }

                classes.push(dayClass);
                classes.push('heat-' + String(heatLevel));
            }

            cells.push([
                '<button type="button" class="' + classes.join(' ') + '" data-date="' + dateKey + '">',
                '  <span class="day-number">' + day + '</span>',
                count > 0 ? '  <span class="day-count">' + count + ' trade' + (count === 1 ? '' : 's') + '</span>' : '',
                count > 0
                    ? '  <span class="day-pnl ' + dayLabelClass + '">' + dayLabel + '</span>'
                    : '',
                '</button>'
            ].join(''));
        }

        while (cells.length % 7 !== 0) {
            var nextOffset = cells.length - (startWeekDay + daysInMonth) + 1;
            var nextDate = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, nextOffset);
            var nextDateKey = toDateKey(nextDate);
            cells.push('<button type="button" class="day-cell is-outside" data-date="' + nextDateKey + '"><span class="day-number">' + nextDate.getDate() + '</span></button>');
        }

        grid.innerHTML = cells.join('');

        Array.from(grid.querySelectorAll('.day-cell')).forEach(function (button) {
            button.addEventListener('click', function () {
                var pickedDate = button.getAttribute('data-date');
                var pickedMonth = pickedDate.slice(0, 7);

                state.selectedDate = pickedDate;

                if (pickedMonth !== state.currentMonth) {
                    state.currentMonth = pickedMonth;
                    loadMonthEntries().catch(console.error);
                    return;
                }

                renderCalendar();
                renderDayDetails();
            });
        });
    }

    async function loadMonthEntries() {
        var data = await fetchJson('/api/calendar/entries?month=' + encodeURIComponent(state.currentMonth));
        state.entries = data.entries || [];

        if (!state.selectedDate.startsWith(state.currentMonth)) {
            state.selectedDate = state.currentMonth + '-01';
        }

        updateMonthSummary();
        renderCalendar();
        renderDayDetails();
    }

    async function loadSession() {
        var data = await fetchJson('/api/auth/session');

        if (!data.loggedIn || !data.user) {
            window.location.href = '/#signup';
            return;
        }

        setText('user-email', data.user.email || '-');
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

    prevMonthButton.addEventListener('click', function () {
        var date = monthKeyToDate(state.currentMonth);
        date.setMonth(date.getMonth() - 1);
        state.currentMonth = toMonthKey(date);
        state.selectedDate = state.currentMonth + '-01';
        state.autoFollowCurrentMonth = false;
        loadMonthEntries().catch(console.error);
    });

    nextMonthButton.addEventListener('click', function () {
        var date = monthKeyToDate(state.currentMonth);
        date.setMonth(date.getMonth() + 1);
        state.currentMonth = toMonthKey(date);
        state.selectedDate = state.currentMonth + '-01';
        state.autoFollowCurrentMonth = false;
        loadMonthEntries().catch(console.error);
    });

    todayButton.addEventListener('click', function () {
        var today = new Date();
        state.currentMonth = toMonthKey(today);
        state.selectedDate = toDateKey(today);
        state.autoFollowCurrentMonth = true;
        loadMonthEntries().catch(console.error);
    });

    if (logoutButton) {
        logoutButton.addEventListener('click', logout);
    }

    if (togglePnlButton) {
        togglePnlButton.addEventListener('click', function () {
            setHeatmapMode('pnl');
        });
    }

    if (toggleWinrateButton) {
        toggleWinrateButton.addEventListener('click', function () {
            setHeatmapMode('winrate');
        });
    }

    updateLegendTexts();

    Promise.all([loadSession(), loadMonthEntries()]).catch(function (error) {
        console.error(error);
        window.location.href = '/#signup';
    });

    setInterval(function () {
        maybeAutoAdvanceMonth().catch(function (error) {
            console.error(error);
        });
    }, 60 * 1000);
})();
