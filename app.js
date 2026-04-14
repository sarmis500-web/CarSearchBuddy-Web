// CarSearchBuddy — PWA with Inventory + Leases tabs
// Reads data.json (inventory), leases.json, dealers.json, zip_coords.json

(function () {
    'use strict';

    // ===== STATE =====
    let allVehicles = [];
    let filteredVehicles = [];
    let metadata = {};

    let allLeases = [];
    let filteredLeases = [];
    let dealersByMake = {};
    let zipCoords = {};
    let userZipLat = null;
    let userZipLng = null;

    // Pagination
    const PAGE_SIZE = 50;
    let inventoryShown = 0;
    let leasesShown = 0;

    // ===== DOM REFS — Tabs =====
    const tabs = document.querySelectorAll('.tab');
    const tabContents = document.querySelectorAll('.tab-content');

    // ===== DOM REFS — Inventory =====
    const searchInput = document.getElementById('search-input');
    const clearBtn = document.getElementById('clear-search');
    const filterMake = document.getElementById('filter-make');
    const filterYear = document.getElementById('filter-year');
    const filterPrice = document.getElementById('filter-price');
    const vehicleList = document.getElementById('vehicle-list');
    const resultsCount = document.getElementById('results-count');
    const lastUpdated = document.getElementById('last-updated');
    const emptyState = document.getElementById('empty-state');
    const resetBtn = document.getElementById('reset-filters');

    // ===== DOM REFS — Leases =====
    const leaseZipInput = document.getElementById('lease-zip');
    const leaseFilterMake = document.getElementById('lease-filter-make');
    const leaseFilterBody = document.getElementById('lease-filter-body');
    const leaseMaxPayment = document.getElementById('lease-max-payment');
    const leaseMaxLabel = document.getElementById('lease-max-label');
    const leaseList = document.getElementById('lease-list');
    const leaseResultsCount = document.getElementById('lease-results-count');
    const leaseEmptyState = document.getElementById('lease-empty-state');
    const leaseResetBtn = document.getElementById('lease-reset-filters');

    const loadingState = document.getElementById('loading-state');

    // ===== TAB SWITCHING =====
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.tab;
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            tabContents.forEach(tc => tc.classList.remove('active'));
            document.getElementById('tab-' + target).classList.add('active');
        });
    });

    // ===== HAVERSINE DISTANCE =====
    function haversineDistance(lat1, lng1, lat2, lng2) {
        const R = 3958.8; // Earth radius in miles
        const toRad = Math.PI / 180;
        const dLat = (lat2 - lat1) * toRad;
        const dLng = (lng2 - lng1) * toRad;
        const a = Math.sin(dLat / 2) ** 2 +
                  Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
                  Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.asin(Math.sqrt(a));
    }

    // ===== INIT =====
    async function init() {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('sw.js').catch(() => {});
        }

        try {
            // Load all data in parallel
            const [invResp, leaseResp, dealerResp, zipResp] = await Promise.all([
                fetch('data.json'),
                fetch('leases.json'),
                fetch('dealers.json'),
                fetch('zip_coords.json')
            ]);

            // Inventory
            if (invResp.ok) {
                const data = await invResp.json();
                metadata = data.metadata || {};
                allVehicles = (data.vehicles || []).map(v => ({
                    ...v,
                    _search: `${v.year} ${v.make} ${v.model} ${v.trim || ''} ${v.dealer_name}`.toLowerCase()
                }));
                populateInventoryFilters();
                applyInventoryFilters();
                updateMeta();
            }

            // Leases
            if (leaseResp.ok) {
                const leaseData = await leaseResp.json();
                allLeases = leaseData.offers || [];
                populateLeaseFilters();
                applyLeaseFilters();
            }

            // Dealers
            if (dealerResp.ok) {
                const dealerData = await dealerResp.json();
                dealersByMake = dealerData.dealers_by_make || {};
            }

            // ZIP coords
            if (zipResp.ok) {
                zipCoords = await zipResp.json();
            }

            loadingState.classList.add('hidden');
        } catch (err) {
            loadingState.innerHTML = `<p style="color:var(--red)">&#9888; Could not load data.</p>`;
            console.error(err);
        }
    }

    // ===== INVENTORY: Filters =====
    function populateInventoryFilters() {
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

    function applyInventoryFilters() {
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

        renderInventory();
    }

    function renderInventory() {
        clearBtn.classList.toggle('visible', searchInput.value.length > 0);

        if (filteredVehicles.length === 0 && allVehicles.length > 0) {
            vehicleList.innerHTML = '';
            emptyState.classList.remove('hidden');
        } else {
            emptyState.classList.add('hidden');
            renderVehicleCards();
        }

        resultsCount.textContent = `${filteredVehicles.length} vehicle${filteredVehicles.length !== 1 ? 's' : ''}`;
    }

    function buildVehicleCard(v) {
        const card = document.createElement('article');
        card.className = 'vehicle-card';

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
                ${mileageStr ? `<span class="detail-chip">${mileageStr}</span>` : ''}
                ${v.platform ? `<span class="detail-chip">${v.platform}</span>` : ''}
            </div>
            <div class="card-dealer">${v.dealer_name}${v.dealer_city ? ', ' + v.dealer_city : ''}</div>
        `;

        if (v.source_url) {
            card.addEventListener('click', () => window.open(v.source_url, '_blank'));
        }

        return card;
    }

    function renderVehicleCards() {
        vehicleList.innerHTML = '';
        inventoryShown = 0;
        loadMoreVehicles();
    }

    function loadMoreVehicles() {
        // Remove existing Load More button
        const existingBtn = vehicleList.querySelector('.load-more-btn');
        if (existingBtn) existingBtn.remove();

        const frag = document.createDocumentFragment();
        const end = Math.min(inventoryShown + PAGE_SIZE, filteredVehicles.length);

        for (let i = inventoryShown; i < end; i++) {
            frag.appendChild(buildVehicleCard(filteredVehicles[i]));
        }

        vehicleList.appendChild(frag);
        inventoryShown = end;

        if (inventoryShown < filteredVehicles.length) {
            const btn = document.createElement('button');
            btn.className = 'load-more-btn';
            btn.textContent = `Load More (${filteredVehicles.length - inventoryShown} remaining)`;
            btn.addEventListener('click', loadMoreVehicles);
            vehicleList.appendChild(btn);
        }
    }

    function updateMeta() {
        if (metadata.scraped_at) {
            const d = new Date(metadata.scraped_at);
            lastUpdated.textContent = `Updated ${d.toLocaleDateString()}`;
        }
    }

    // ===== LEASE: Filters =====
    function populateLeaseFilters() {
        const makes = [...new Set(allLeases.map(o => o.make))].sort();
        makes.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            leaseFilterMake.appendChild(opt);
        });

        const bodies = [...new Set(allLeases.map(o => o.body_style).filter(Boolean))].sort();
        bodies.forEach(b => {
            const opt = document.createElement('option');
            opt.value = b;
            opt.textContent = b;
            leaseFilterBody.appendChild(opt);
        });
    }

    function applyLeaseFilters() {
        const make = leaseFilterMake.value;
        const body = leaseFilterBody.value;
        const maxPay = parseInt(leaseMaxPayment.value);

        filteredLeases = allLeases.filter(o => {
            if (make && o.make !== make) return false;
            if (body && o.body_style !== body) return false;
            if (o.monthly_payment > maxPay) return false;
            return true;
        });

        // Sort: lowest monthly payment first
        filteredLeases.sort((a, b) => a.monthly_payment - b.monthly_payment);

        renderLeases();
    }

    function renderLeases() {
        if (filteredLeases.length === 0 && allLeases.length > 0) {
            leaseList.innerHTML = '';
            leaseEmptyState.classList.remove('hidden');
        } else {
            leaseEmptyState.classList.add('hidden');
            renderLeaseCards();
        }

        leaseResultsCount.textContent = `${filteredLeases.length} lease offer${filteredLeases.length !== 1 ? 's' : ''}`;
    }

    function getNearbyDealers(make, count) {
        const dealers = dealersByMake[make] || [];
        if (!dealers.length) return [];

        if (userZipLat != null && userZipLng != null) {
            // Sort by distance and take closest N
            return dealers
                .map(d => ({
                    ...d,
                    distance: haversineDistance(userZipLat, userZipLng, d.lat, d.lng)
                }))
                .sort((a, b) => a.distance - b.distance)
                .slice(0, count);
        }

        // No ZIP — return first N alphabetically
        return dealers.slice(0, count).map(d => ({ ...d, distance: null }));
    }

    function buildLeaseCard(o) {
        const card = document.createElement('article');
        card.className = 'lease-card';

        const monthlyStr = `$${Math.round(o.monthly_payment).toLocaleString()}`;
        const dueStr = o.due_at_signing != null
            ? `$${Math.round(o.due_at_signing).toLocaleString()} due at signing`
            : '';
        const termStr = o.term_months ? `${o.term_months} mo` : '';
        const mileStr = o.annual_mileage
            ? `${(o.annual_mileage / 1000).toFixed(0)}k mi/yr`
            : '';

        let effectiveStr = '';
        if (o.due_at_signing != null && o.term_months) {
            const eff = (o.due_at_signing + o.monthly_payment * o.term_months) / o.term_months;
            effectiveStr = `$${Math.round(eff)}/mo effective`;
        }

        let aprHtml = '';
        if (o.money_factor != null) {
            const apr = (o.money_factor * 2400).toFixed(1);
            const aprNum = parseFloat(apr);
            const aprClass = aprNum <= 3 ? 'apr-low' : aprNum <= 6 ? 'apr-mid' : 'apr-high';
            aprHtml = `<span class="lease-detail-chip lease-apr ${aprClass}">${apr}% APR</span>`;
        }

        const endDateStr = o.offer_end_date ? `Ends ${o.offer_end_date}` : '';

        const nearby = getNearbyDealers(o.make, 5);

        let dealerChipsHtml = '';
        if (nearby.length > 0) {
            const chips = nearby.map(d => {
                let url = d.website || '';
                if (url && !url.startsWith('http')) url = 'https://' + url;
                const distStr = d.distance != null ? ` <span class="dealer-distance">${Math.round(d.distance)} mi</span>` : '';
                return `<a class="dealer-chip" href="${url}" target="_blank" rel="noopener">${d.name}${distStr}</a>`;
            }).join('');

            dealerChipsHtml = `
                <hr class="lease-divider">
                <div class="dealer-section-title">Nearby ${o.make} Dealers</div>
                <div class="dealer-chips">${chips}</div>
            `;
        }

        card.innerHTML = `
            <div class="lease-header">
                <div>
                    <div class="lease-vehicle-name">${o.year} ${o.make} ${o.model}${o.trim ? ' ' + o.trim : ''}</div>
                    ${o.body_style ? `<div class="lease-body-style">${o.body_style}</div>` : ''}
                </div>
                <div class="lease-payment">
                    <div class="lease-monthly">${monthlyStr}</div>
                    <div class="lease-monthly-label">/month</div>
                </div>
            </div>
            <div class="lease-details">
                ${termStr ? `<span class="lease-detail-chip">${termStr}</span>` : ''}
                ${dueStr ? `<span class="lease-detail-chip">${dueStr}</span>` : ''}
                ${mileStr ? `<span class="lease-detail-chip">${mileStr}</span>` : ''}
                ${effectiveStr ? `<span class="lease-detail-chip">${effectiveStr}</span>` : ''}
                ${aprHtml}
                ${endDateStr ? `<span class="lease-detail-chip">${endDateStr}</span>` : ''}
            </div>
            ${dealerChipsHtml}
        `;

        return card;
    }

    function renderLeaseCards() {
        leaseList.innerHTML = '';
        leasesShown = 0;
        loadMoreLeases();
    }

    function loadMoreLeases() {
        const existingBtn = leaseList.querySelector('.load-more-btn');
        if (existingBtn) existingBtn.remove();

        const frag = document.createDocumentFragment();
        const end = Math.min(leasesShown + PAGE_SIZE, filteredLeases.length);

        for (let i = leasesShown; i < end; i++) {
            frag.appendChild(buildLeaseCard(filteredLeases[i]));
        }

        leaseList.appendChild(frag);
        leasesShown = end;

        if (leasesShown < filteredLeases.length) {
            const btn = document.createElement('button');
            btn.className = 'load-more-btn';
            btn.textContent = `Load More (${filteredLeases.length - leasesShown} remaining)`;
            btn.addEventListener('click', loadMoreLeases);
            leaseList.appendChild(btn);
        }
    }

    // ===== ZIP CODE HANDLING =====
    function updateZipCoords() {
        const zip = leaseZipInput.value.trim();
        if (zip.length === 5 && zipCoords[zip]) {
            userZipLat = zipCoords[zip].lat;
            userZipLng = zipCoords[zip].lng;
        } else {
            userZipLat = null;
            userZipLng = null;
        }
    }

    // ===== EVENT LISTENERS — Inventory =====
    let invDebounce;
    searchInput.addEventListener('input', () => {
        clearTimeout(invDebounce);
        invDebounce = setTimeout(applyInventoryFilters, 150);
    });

    clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        applyInventoryFilters();
        searchInput.focus();
    });

    filterMake.addEventListener('change', applyInventoryFilters);
    filterYear.addEventListener('change', applyInventoryFilters);
    filterPrice.addEventListener('change', applyInventoryFilters);

    resetBtn.addEventListener('click', () => {
        searchInput.value = '';
        filterMake.value = '';
        filterYear.value = '';
        filterPrice.value = '';
        applyInventoryFilters();
    });

    // ===== EVENT LISTENERS — Leases =====
    leaseZipInput.addEventListener('input', () => {
        updateZipCoords();
        if (leaseZipInput.value.trim().length === 5) {
            applyLeaseFilters(); // Re-render to update distances
        }
    });

    leaseFilterMake.addEventListener('change', applyLeaseFilters);
    leaseFilterBody.addEventListener('change', applyLeaseFilters);

    leaseMaxPayment.addEventListener('input', () => {
        const val = parseInt(leaseMaxPayment.value);
        leaseMaxLabel.textContent = `$${val.toLocaleString()}`;
        applyLeaseFilters();
    });

    leaseResetBtn.addEventListener('click', () => {
        leaseZipInput.value = '';
        leaseFilterMake.value = '';
        leaseFilterBody.value = '';
        leaseMaxPayment.value = '1500';
        leaseMaxLabel.textContent = '$1,500';
        userZipLat = null;
        userZipLng = null;
        applyLeaseFilters();
    });

    // ===== LAUNCH =====
    init();
})();
