'use strict';
/* ── geneticAlgorithm.js — Two-Phase Optimizer v2 ──
   Chiến lược:
   • nb ≤ 10 VÀ nc ≤ 10  →  Brute-force exhaustive (tối ưu tuyệt đối, đảm bảo 100%)
   • Lớn hơn             →  Genetic Algorithm + 2-opt polish
   Matrix: index 0 = A, 1..nb = B stops, nb+1..nb+nc = C stops
*/

const GeneticAlgorithm = (() => {

  const WORKER_CODE = `
'use strict';

/* ═══════════════════════════════════════════════
   HÀM TIỆN ÍCH
═══════════════════════════════════════════════ */

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/* Chi phí tổng:
   A(0) → B[chrom[0..nb-1]] → (từ B cuối) → C[chrom[nb..nb+nc-1]] */
function calcCost(chrom, matrix, nb, nc) {
  let cost = 0, prev = 0;   // prev=0 là A
  for (let i = 0; i < nb; i++) {
    const next = chrom[i] + 1;          // matrix index B_i = chrom[i]+1
    cost += matrix[prev][next];
    prev = next;
  }
  // prev giờ = matrix-index của B cuối (hoặc 0=A nếu nb=0)
  for (let j = 0; j < nc; j++) {
    const next = nb + 1 + chrom[nb + j];  // matrix index C_j
    cost += matrix[prev][next];
    prev = next;
  }
  return cost;
}

/* ═══════════════════════════════════════════════
   BRUTE-FORCE ITERATIVE (không dùng generator)
   Sinh permutation bằng thuật toán Heap
═══════════════════════════════════════════════ */

/* Heap's algorithm — sinh toàn bộ permutation của arr */
function heapPermutations(arr) {
  const result = [];
  const n = arr.length;
  const c = new Array(n).fill(0);
  result.push(arr.slice());
  let i = 0;
  while (i < n) {
    if (c[i] < i) {
      if (i % 2 === 0) {
        const t = arr[0]; arr[0] = arr[i]; arr[i] = t;
      } else {
        const t = arr[c[i]]; arr[c[i]] = arr[i]; arr[i] = t;
      }
      result.push(arr.slice());
      c[i]++;
      i = 0;
    } else {
      c[i] = 0;
      i++;
    }
  }
  return result;
}

function bruteForce(matrix, nb, nc) {
  const bIdx = Array.from({ length: nb }, (_, i) => i);
  const cIdx = Array.from({ length: nc }, (_, i) => i);

  let bestChrom = null, bestCost = Infinity;

  if (nb === 0) {
    // Chỉ có C: duyệt hết permutation C
    const cPerms = heapPermutations(cIdx.slice());
    for (const cPerm of cPerms) {
      const chrom = cPerm.slice();
      const c = calcCost(chrom, matrix, 0, nc);
      if (c < bestCost) { bestCost = c; bestChrom = chrom.slice(); }
    }
    return { bestChrom, bestCost };
  }

  if (nc === 0) {
    // Chỉ có B: duyệt hết permutation B
    const bPerms = heapPermutations(bIdx.slice());
    for (const bPerm of bPerms) {
      const chrom = bPerm.slice();
      const c = calcCost(chrom, matrix, nb, 0);
      if (c < bestCost) { bestCost = c; bestChrom = chrom.slice(); }
    }
    return { bestChrom, bestCost };
  }

  // Có cả B và C: duyệt hết B × C
  const bPerms = heapPermutations(bIdx.slice());
  const cPerms = heapPermutations(cIdx.slice());
  for (const bPerm of bPerms) {
    for (const cPerm of cPerms) {
      const chrom = [...bPerm, ...cPerm];
      const c = calcCost(chrom, matrix, nb, nc);
      if (c < bestCost) { bestCost = c; bestChrom = chrom.slice(); }
    }
  }
  return { bestChrom, bestCost };
}

/* ═══════════════════════════════════════════════
   GENETIC ALGORITHM (cho bài toán lớn)
═══════════════════════════════════════════════ */

function calcFitness(chrom, matrix, nb, nc) {
  const c = calcCost(chrom, matrix, nb, nc);
  return c === 0 ? 0 : 1 / c;
}

function oxSeg(p1, p2) {
  const n = p1.length;
  if (n <= 1) return p1.slice();
  let a = Math.floor(Math.random() * n);
  let b = Math.floor(Math.random() * n);
  if (a > b) { const t = a; a = b; b = t; }
  const child = new Array(n).fill(-1);
  for (let i = a; i <= b; i++) child[i] = p1[i];
  const used = new Set(child.filter(x => x >= 0));
  const rest = p2.filter(x => !used.has(x));
  let ri = 0;
  for (let i = 0; i < n; i++) if (child[i] === -1) child[i] = rest[ri++];
  return child;
}

function crossover(p1, p2, nb, nc) {
  const bC = nb > 0 ? oxSeg(p1.slice(0, nb), p2.slice(0, nb)) : [];
  const cC = nc > 0 ? oxSeg(p1.slice(nb), p2.slice(nb)) : [];
  return [...bC, ...cC];
}

function mutate(chrom, rate, nb, nc) {
  const r = chrom.slice();
  if (Math.random() >= rate) return r;
  const doB = nc === 0 || (nb >= 2 && Math.random() < 0.5);
  if (doB && nb >= 2) {
    const i = Math.floor(Math.random() * nb);
    const j = Math.floor(Math.random() * nb);
    const t = r[i]; r[i] = r[j]; r[j] = t;
  } else if (!doB && nc >= 2) {
    const i = nb + Math.floor(Math.random() * nc);
    const j = nb + Math.floor(Math.random() * nc);
    const t = r[i]; r[i] = r[j]; r[j] = t;
  }
  return r;
}

function twoOptSeg(chrom, start, len, matrix, nb, nc) {
  if (len < 2) return chrom;
  let best = chrom.slice(), bestCost = calcCost(best, matrix, nb, nc), improved = true;
  while (improved) {
    improved = false;
    outer: for (let i = start; i < start + len - 1; i++) {
      for (let j = i + 1; j < start + len; j++) {
        const cand = best.slice();
        let l = i, r = j;
        while (l < r) { const t = cand[l]; cand[l] = cand[r]; cand[r] = t; l++; r--; }
        const c = calcCost(cand, matrix, nb, nc);
        if (c < bestCost) { bestCost = c; best = cand; improved = true; break outer; }
      }
    }
  }
  return best;
}

function nearestNeighbor(matrix, nb, nc) {
  const chrom = [];
  const bVis = new Array(nb).fill(false);
  let cur = 0;
  for (let s = 0; s < nb; s++) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < nb; i++) {
      if (!bVis[i] && matrix[cur][i + 1] < bd) { bd = matrix[cur][i + 1]; best = i; }
    }
    bVis[best] = true; chrom.push(best); cur = best + 1;
  }
  const cVis = new Array(nc).fill(false);
  for (let s = 0; s < nc; s++) {
    let best = -1, bd = Infinity;
    for (let j = 0; j < nc; j++) {
      if (!cVis[j] && matrix[cur][nb + 1 + j] < bd) { bd = matrix[cur][nb + 1 + j]; best = j; }
    }
    cVis[best] = true; chrom.push(best); cur = nb + 1 + best;
  }
  return chrom;
}

function tournament(pop, fits, k) {
  let best = Math.floor(Math.random() * pop.length);
  for (let i = 1; i < k; i++) {
    const idx = Math.floor(Math.random() * pop.length);
    if (fits[idx] > fits[best]) best = idx;
  }
  return pop[best];
}

/* ═══════════════════════════════════════════════
   WORKER ENTRY POINT
═══════════════════════════════════════════════ */
self.onmessage = function(e) {
  const { matrix, nb, nc, params } = e.data;
  const { POPULATION_SIZE, MAX_GENERATIONS, MUTATION_RATE, ELITE_SIZE, TOURNAMENT_SIZE } = params;

  if (nb + nc === 0) {
    self.postMessage({ type: 'done', bestRoute: [], bestCost: 0 });
    return;
  }

  /* ── BRUTE FORCE khi đủ nhỏ (mỗi pha ≤ 10 điểm) ── */
  const BF_LIMIT = 10;
  if (nb <= BF_LIMIT && nc <= BF_LIMIT) {
    console.log('[Optimizer] Brute-force mode: nb=' + nb + ' nc=' + nc);
    self.postMessage({ type: 'progress', generation: 0, progress: 20, bestCost: 0 });

    const { bestChrom, bestCost } = bruteForce(matrix, nb, nc);

    console.log('[Optimizer] Brute-force done. bestCost=' + bestCost + ' bestChrom=' + JSON.stringify(bestChrom));
    self.postMessage({ type: 'progress', generation: 1, progress: 100, bestCost });
    self.postMessage({ type: 'done', bestRoute: bestChrom, bestCost: Math.round(bestCost) });
    return;
  }

  /* ── GENETIC ALGORITHM cho bài toán lớn ── */
  console.log('[Optimizer] GA mode: nb=' + nb + ' nc=' + nc);
  const bIdx = Array.from({ length: nb }, (_, i) => i);
  const cIdx = Array.from({ length: nc }, (_, i) => i);
  function rndChrom() { return [...shuffle(bIdx), ...shuffle(cIdx)]; }

  let pop = [nearestNeighbor(matrix, nb, nc)];
  for (let s = 0; s < Math.min(10, POPULATION_SIZE - 1); s++) {
    pop.push(mutate(nearestNeighbor(matrix, nb, nc), 1.0, nb, nc));
  }
  while (pop.length < POPULATION_SIZE) pop.push(rndChrom());

  let allBest = null, allBestCost = Infinity;
  for (const ind of pop) {
    const c = calcCost(ind, matrix, nb, nc);
    if (c < allBestCost) { allBestCost = c; allBest = ind.slice(); }
  }

  for (let gen = 0; gen < MAX_GENERATIONS; gen++) {
    const fits = pop.map(c => calcFitness(c, matrix, nb, nc));
    const ranked = pop.map((c, i) => ({ c, f: fits[i] })).sort((a, b) => b.f - a.f);
    const curCost = calcCost(ranked[0].c, matrix, nb, nc);
    if (curCost < allBestCost) { allBestCost = curCost; allBest = ranked[0].c.slice(); }

    const newPop = ranked.slice(0, ELITE_SIZE).map(x => x.c);
    while (newPop.length < POPULATION_SIZE) {
      const p1 = tournament(pop, fits, TOURNAMENT_SIZE);
      const p2 = tournament(pop, fits, TOURNAMENT_SIZE);
      newPop.push(mutate(crossover(p1, p2, nb, nc), MUTATION_RATE, nb, nc));
    }
    pop = newPop;

    if (gen % 10 === 0 || gen === MAX_GENERATIONS - 1) {
      self.postMessage({
        type: 'progress', generation: gen,
        progress: Math.round(gen / (MAX_GENERATIONS - 1) * 100),
        bestCost: allBestCost, bestRoute: allBest
      });
    }
  }

  let polished = twoOptSeg(allBest, 0, nb, matrix, nb, nc);
  polished = twoOptSeg(polished, nb, nc, matrix, nb, nc);
  const finalCost = calcCost(polished, matrix, nb, nc);
  self.postMessage({ type: 'done', bestRoute: polished, bestCost: Math.round(finalCost) });
};
`;

  let worker = null;

  function createWorker() {
    const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
    const url  = URL.createObjectURL(blob);
    const w    = new Worker(url);
    URL.revokeObjectURL(url);
    return w;
  }

  function optimize(distanceMatrix, nb, nc, params, onProgress) {
    return new Promise((resolve, reject) => {
      if (worker) { worker.terminate(); }
      worker = createWorker();

      worker.onmessage = e => {
        const d = e.data;
        if (d.type === 'progress') {
          onProgress({ gen: d.generation, pct: d.progress, bestCost: d.bestCost });
        } else if (d.type === 'done') {
          worker = null;
          resolve({ bestRoute: d.bestRoute, bestCost: d.bestCost });
        }
      };
      worker.onerror = err => {
        console.error('[GA Worker error]', err.message);
        worker = null;
        reject(new Error(err.message));
      };

      worker.postMessage({ matrix: distanceMatrix, nb, nc, params });
    });
  }

  function cancel() {
    if (worker) { worker.terminate(); worker = null; }
  }

  return { optimize, cancel };
})();
