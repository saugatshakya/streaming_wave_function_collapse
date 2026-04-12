export class StatsStore {
  constructor() { this.reset(); }

  reset() {
    this.generated = [];
    this.batchRows = [];
    this.revisitConsistency = true;
    this.memoryEvictions = 0;
  }

  recordChunk(record) { this.generated.push(record); }
  recordBatchComparison(row) { this.batchRows.push(row); }
  setRevisitConsistency(ok) { this.revisitConsistency = this.revisitConsistency && ok; }
  recordMemoryEviction() { this.memoryEvictions += 1; }

  summary() {
    const gens = this.generated.filter(r => r.loadSource === 'generated');
    const avg = (arr, fn) => arr.length ? arr.reduce((s, x) => s + fn(x), 0) / arr.length : 0;
    return {
      generatedChunks: gens.length,
      cacheLoads: this.generated.filter(r => r.loadSource === 'cache').length,
      storageLoads: this.generated.filter(r => r.loadSource === 'storage').length,
      avgGenerationTime: avg(gens, r => r.timeMs),
      avgBacktracks: avg(gens, r => r.backtracks),
      avgAttempts: avg(gens, r => r.attempts),
      seamViolations: gens.filter(r => !r.seamOk).length,
      internalViolations: gens.filter(r => !r.internalOk).length,
      revisitConsistency: this.revisitConsistency,
      memoryEvictions: this.memoryEvictions,
    };
  }

  exportJSON() {
    return JSON.stringify({
      generated: this.generated,
      batchRows: this.batchRows,
      revisitConsistency: this.revisitConsistency,
      memoryEvictions: this.memoryEvictions,
    }, null, 2);
  }
}
