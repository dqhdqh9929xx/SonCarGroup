'use strict';
/* ── geneticAlgorithm.js — Two-Phase GA: A→B*→C* ── */

const GeneticAlgorithm = (() => {

  /* ─────────────────────────────────────────────────────────────
     WORKER CODE (inline Blob)
     Matrix layout:  index 0 = Origin A
                     indices 1..nb   = B stops
                     indices nb+1..nb+nc = C stops
     Chromosome:     [b_perm(0..nb-1) | c_perm(0..nc-1)]
     Route:          A → B[bperm] → C[cperm]
  ───────────────────────────────────────────────────────────── */
  const WORKER_CODE = `
'use strict';

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    const t = a[i]; a[i]=a[j]; a[j]=t;
  }
  return a;
}

/* Total route cost for two-phase chromosome */
function calcCost(chrom, matrix, nb, nc) {
  let cost = 0, prev = 0;
  for (let i = 0; i < nb; i++) {
    const next = chrom[i] + 1;
    cost += matrix[prev][next]; prev = next;
  }
  for (let j = 0; j < nc; j++) {
    const next = nb + 1 + chrom[nb+j];
    cost += matrix[prev][next]; prev = next;
  }
  return cost;
}
function calcFitness(chrom, matrix, nb, nc) {
  const c = calcCost(chrom, matrix, nb, nc);
  return c === 0 ? 0 : 1/c;
}

/* OX crossover on a single segment array */
function oxSeg(p1, p2) {
  const n = p1.length;
  if (n <= 1) return p1.slice();
  let a = Math.floor(Math.random()*n);
  let b = Math.floor(Math.random()*n);
  if (a > b) { const t=a; a=b; b=t; }
  const child = new Array(n).fill(-1);
  for (let i=a; i<=b; i++) child[i]=p1[i];
  const used = new Set(child.filter(x=>x>=0));
  const rest = p2.filter(x=>!used.has(x));
  let ri=0;
  for (let i=0; i<n; i++) if (child[i]===-1) child[i]=rest[ri++];
  return child;
}

/* Two-phase crossover: OX on B-part, OX on C-part separately */
function crossover(p1, p2, nb, nc) {
  const bC = nb>0 ? oxSeg(p1.slice(0,nb), p2.slice(0,nb)) : [];
  const cC = nc>0 ? oxSeg(p1.slice(nb), p2.slice(nb)) : [];
  return [...bC, ...cC];
}

/* Swap mutation: within B portion OR within C portion */
function mutate(chrom, rate, nb, nc) {
  const r = chrom.slice();
  if (Math.random() >= rate) return r;
  const doB = nc===0 || (nb>=2 && Math.random()<0.5);
  if (doB && nb>=2) {
    const i=Math.floor(Math.random()*nb), j=Math.floor(Math.random()*nb);
    const t=r[i]; r[i]=r[j]; r[j]=t;
  } else if (!doB && nc>=2) {
    const i=nb+Math.floor(Math.random()*nc), j=nb+Math.floor(Math.random()*nc);
    const t=r[i]; r[i]=r[j]; r[j]=t;
  }
  return r;
}

/* 2-opt within a segment [start .. start+len-1] of chrom */
function twoOptSeg(chrom, start, len, matrix, nb, nc) {
  if (len < 2) return chrom;
  let best = chrom.slice(), bestCost = calcCost(best, matrix, nb, nc), improved = true;
  while (improved) {
    improved = false;
    outer: for (let i=start; i<start+len-1; i++) {
      for (let j=i+1; j<start+len; j++) {
        const cand = best.slice();
        let l=i, r=j;
        while(l<r){const t=cand[l];cand[l]=cand[r];cand[r]=t;l++;r--;}
        const c=calcCost(cand,matrix,nb,nc);
        if (c<bestCost){bestCost=c;best=cand;improved=true;break outer;}
      }
    }
  }
  return best;
}

/* Nearest-neighbor seeding: greedy B then greedy C */
function nearestNeighbor(matrix, nb, nc) {
  const chrom=[];
  const bVis=new Array(nb).fill(false);
  let cur=0;
  for (let s=0; s<nb; s++) {
    let best=-1, bd=Infinity;
    for (let i=0; i<nb; i++) if(!bVis[i]&&matrix[cur][i+1]<bd){bd=matrix[cur][i+1];best=i;}
    bVis[best]=true; chrom.push(best); cur=best+1;
  }
  const cVis=new Array(nc).fill(false);
  for (let s=0; s<nc; s++) {
    let best=-1, bd=Infinity;
    for (let j=0; j<nc; j++) if(!cVis[j]&&matrix[cur][nb+1+j]<bd){bd=matrix[cur][nb+1+j];best=j;}
    cVis[best]=true; chrom.push(best); cur=nb+1+best;
  }
  return chrom;
}

/* Tournament selection */
function tournament(pop, fits, k) {
  let best=Math.floor(Math.random()*pop.length);
  for (let i=1;i<k;i++){const idx=Math.floor(Math.random()*pop.length);if(fits[idx]>fits[best])best=idx;}
  return pop[best];
}

self.onmessage = function(e) {
  const { matrix, nb, nc, params } = e.data;
  const { POPULATION_SIZE, MAX_GENERATIONS, MUTATION_RATE, ELITE_SIZE, TOURNAMENT_SIZE } = params;

  if (nb+nc === 0) { self.postMessage({type:'done',bestRoute:[],bestCost:0}); return; }

  const bIdx = Array.from({length:nb},(_,i)=>i);
  const cIdx = Array.from({length:nc},(_,i)=>i);
  function rndChrom(){ return [...shuffle(bIdx),...shuffle(cIdx)]; }

  let pop = [nearestNeighbor(matrix,nb,nc)];
  while (pop.length < POPULATION_SIZE) pop.push(rndChrom());

  let allBest = pop[0].slice();
  let allBestCost = calcCost(allBest, matrix, nb, nc);

  for (let gen=0; gen<MAX_GENERATIONS; gen++) {
    const fits = pop.map(c=>calcFitness(c,matrix,nb,nc));
    const ranked = pop.map((c,i)=>({c,f:fits[i]})).sort((a,b)=>b.f-a.f);

    const curCost = calcCost(ranked[0].c, matrix, nb, nc);
    if (curCost < allBestCost) { allBestCost=curCost; allBest=ranked[0].c.slice(); }

    const newPop = ranked.slice(0, ELITE_SIZE).map(x=>x.c);
    while (newPop.length < POPULATION_SIZE) {
      const p1=tournament(pop,fits,TOURNAMENT_SIZE);
      const p2=tournament(pop,fits,TOURNAMENT_SIZE);
      newPop.push(mutate(crossover(p1,p2,nb,nc),MUTATION_RATE,nb,nc));
    }
    pop = newPop;

    if (gen%10===0 || gen===MAX_GENERATIONS-1) {
      self.postMessage({type:'progress',generation:gen,
        progress:Math.round(gen/(MAX_GENERATIONS-1)*100),
        bestCost:allBestCost, bestRoute:allBest});
    }
  }

  /* Final 2-opt polish on both phases */
  let polished = twoOptSeg(allBest, 0, nb, matrix, nb, nc);
  polished = twoOptSeg(polished, nb, nc, matrix, nb, nc);
  const finalCost = calcCost(polished, matrix, nb, nc);

  self.postMessage({type:'done', bestRoute:polished, bestCost:Math.round(finalCost)});
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

  /**
   * @param {number[][]} distanceMatrix  Full NxN matrix (A + B stops + C stops)
   * @param {number}     nb              Number of B stops
   * @param {number}     nc              Number of C stops
   * @param {object}     params          GA hyperparameters
   * @param {function}   onProgress      ({gen, pct, bestCost}) callback
   * @returns {Promise<{bestRoute, bestCost}>}
   *   bestRoute = [...b_order (len nb), ...c_order (len nc)]
   */
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
      worker.onerror = err => { worker = null; reject(new Error(err.message)); };

      worker.postMessage({ matrix: distanceMatrix, nb, nc, params });
    });
  }

  function cancel() {
    if (worker) { worker.terminate(); worker = null; }
  }

  return { optimize, cancel };
})();
