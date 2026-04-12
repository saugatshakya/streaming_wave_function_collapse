
class ExperimentRunner {
    constructor(world, renderer) {
        this.world = world;
        this.renderer = renderer;
        this.results = [];
        this.screenshotFiles = [];
    }

    async runAll() {
        const sizes = [10, 20, 30];
        for (const size of sizes) {
            await this.runSizeExperiment(size);
        }
        await this.exportResults();
    }

    async runSizeExperiment(size) {
        this.resetWorldForSize(size);

        const stats = {
            size,
            steps: 20,
            chunksGenerated: 0,
            totalTimeMs: 0,
            avgTimeMs: 0,
            attempts: 0,
            backtracks: 0,
            memorySeries: [],
            perStepTimeMs: []
        };

        for (let step = 0; step < 20; step++) {
            const start = performance.now();

            if (typeof this.world.stepExperiment === "function") {
                await this.world.stepExperiment();
            } else if (typeof this.world.tick === "function") {
                // Fallback for projects without stepExperiment()
                this.world.tick(performance.now());
            }

            const elapsed = performance.now() - start;
            stats.totalTimeMs += elapsed;
            stats.perStepTimeMs.push(elapsed);
            stats.chunksGenerated += this.world.lastGenerated || 0;
            stats.attempts += this.world.lastAttempts || 0;
            stats.backtracks += this.world.lastBacktracks || 0;
            stats.memorySeries.push(this.world.activeChunks || this.world.memory?.size || 0);

            if (step === 0 || step === 10 || step === 19) {
                const label = `progress_size${size}_step${step + 1}`;
                await this.saveScreenshotPNG(label);
            }

            await new Promise(r => setTimeout(r, 25));
        }

        stats.avgTimeMs = stats.totalTimeMs / stats.steps;
        stats.peakMemory = Math.max(0, ...stats.memorySeries);
        stats.avgMemory = stats.memorySeries.length
            ? stats.memorySeries.reduce((a, b) => a + b, 0) / stats.memorySeries.length
            : 0;

        this.results.push(stats);
    }

    resetWorldForSize(size) {
        if (typeof this.world.reset === "function") {
            this.world.reset(size);
            return;
        }
        if ("chunkSize" in this.world) this.world.chunkSize = size;
    }

    async saveScreenshotPNG(label) {
        const canvas = document.querySelector("canvas");
        if (!canvas) return;

        const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
        if (!blob) return;

        const filename = `${label}.png`;
        this.screenshotFiles.push(filename);

        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        await new Promise(r => setTimeout(r, 150));
    }

    async exportResults() {
        const data = {
            results: this.results,
            screenshotFiles: this.screenshotFiles,
            timestamp: Date.now()
        };

        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "experiment_results_v14.json";
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
}

window.runExperimentV14 = function(world, renderer) {
    const runner = new ExperimentRunner(world, renderer);
    runner.runAll();
};
