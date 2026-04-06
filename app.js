// CarSearchBuddy — PWA Vehicle Search App
// Reads inventory.json produced by the Python Data Engine

(function () {
    'use strict';

    // --- State ---
    let allVehicles = [];
    let filteredVehicles = [];
    let metadata = {};

    // --- DOM Refs ---
    const searchInput = document.getElementById('search-input');
    const clearBtn = document.getElementById('clear-search');
    const filterMake = document.getElementById('filter-make');
    const filterYear = document.getElementById('filter-year');
    const filterPrice = document.getElementById('filter-price');
    const vehicleList = document.getElementById('vehicle-list');
    const resultsCount = document.getElementById('results-count');
    const lastUpdated = document.getElementById('last-updated');
    const loadingState = document.getElementById('loading-state');
    const emptyState = document.getElementById('empty-state');
    const resetBtn = document.getElementById('reset-filters');

    // --- Init ---
    async function init() {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('sw.js').catch(() => {});
        }

        try {
            const resp = await fetch('data.json');
            if (!resp.ok) throw new Error('Failed to load inventory');
            const data = await resp.json();

            metadata = data.metadata || {};
            allVehicles = (data.vehicles || []).map(v => ({
                ...v,
                _search: `${v.year} ${v.make} ${v.model} ${v.trim || ''} ${v.dealer_name}`.toLowerCase()
            }));

            populateFilters();
            applyFilters();
            updateMeta();
            loadingState.classList.add('hidden');
        } catch (err) {
            loadingState.innerHTML = `<p style="color:var(--red)">⚠ Could not load inventory data.</p>`;
            console.error(err);
        }
    }

    // --- Populate Filter Dropdowns ---
    function populateFilters() {
        const makes = [...new Set(allVehicles.map(v => v.make))].sort();
        makes.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            filterMake.appendChild(opt);
        });

        const years = [...new Set(allVehicles.map(v => v.year))].sort((a, b) => b - a);
        years.forEach(y => {
            const opt = document.createElement('option');
            opt.value = y;
            opt.textContent = y;
            filterYear.appendChild(opt);
        });
    }

    // --- Filter & Render ---
    function applyFilters() {
        const query = searchInput.value.toLowerCase().trim();
        const make = filterMake.value;
        const year = filterYear.value;
        const priceRange = filterPrice.value;

        filteredVehicles = allVehicles.filter(v => {
            if (query && !v._search.includes(query)) return false;
            if (make && v.make !== make) return false;
            if (year && v.year !== parseInt(year)) return false;
            if (priceRange) {
                const [min, max] = priceRange.split('-').map(Number);
                if (v.price < min || v.price > max) return false;
            }
            return true;
        });

        render();
    }

    function render() {
        // Show/hide states
        clearBtn.classList.toggle('visible', searchInput.value.length > 0);

        if (filteredVehicles.length === 0 && allVehicles.length > 0) {
            vehicleList.innerHTML = '';
            emptyState.classList.remove('hidden');
        } else {
            emptyState.classList.add('hidden');
            renderCards();
        }

        resultsCount.textContent = `${filteredVehicles.length} vehicle${filteredVehicles.length !== 1 ? 's' : ''}`;
    }

    function renderCards() {
        // For performance, render in a fragment
        const frag = document.createDocumentFragment();

        filteredVehicles.forEach((v, i) => {
            const card = document.createElement('article');
            card.className = 'vehicle-card';
            card.style.animationDelay = `${Math.min(i * 0.03, 0.5)}s`;

            const priceStr = v.price > 0
                ? `$${v.price.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
                : null;

            const mileageStr = v.mileage
                ? `${v.mileage.toLocaleString()} mi`
                : null;

            card.innerHTML = `
                <div class="card-top">
                    <div class="card-title">${v.year} ${v.make} ${v.model}${v.trim ? ' ' + v.trim : ''}</div>
                    ${priceStr
                        ? `<div class="card-price">${priceStr}</div>`
                        : `<div class="card-price no-price">Call for Price</div>`
                    }
                </div>
                <div class="card-details">
                    ${v.condition ? `<span class="detail-chip">${v.condition}</span>` : ''}
                    ${mileageStr ? `<span class="detail-chip">📏 ${mileageStr}</span>` : ''}
                    ${v.platform ? `<span class="detail-chip">🌐 ${v.platform}</span>` : ''}
                </div>
                <div class="card-dealer">📍 ${v.dealer_name}${v.dealer_city ? ', ' + v.dealer_city : ''}</div>
            `;

            if (v.source_url) {
                card.addEventListener('click', () => window.open(v.source_url, '_blank'));
            }

            frag.appendChild(card);
        });

        vehicleList.innerHTML = '';
        vehicleList.appendChild(frag);
    }

    function updateMeta() {
        if (metadata.scraped_at) {
            const d = new Date(metadata.scraped_at);
            lastUpdated.textContent = `Updated ${d.toLocaleDateString()}`;
        }
    }

    // --- Event Listeners ---
    let debounceTimer;
    searchInput.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(applyFilters, 150);
    });

    clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        applyFilters();
        searchInput.focus();
    });

    filterMake.addEventListener('change', applyFilters);
    filterYear.addEventListener('change', applyFilters);
    filterPrice.addEventListener('change', applyFilters);

    resetBtn.addEventListener('click', () => {
        searchInput.value = '';
        filterMake.value = '';
        filterYear.value = '';
        filterPrice.value = '';
        applyFilters();
    });

    // --- Launch ---
    init();
})();
