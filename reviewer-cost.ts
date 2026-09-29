import { StringDecoder } from 'node:string_decoder';

export const REVIEWER_COST_EVENT = 'pi-auto-reviewer:cost';
export const REVIEWER_COST_ENTRY = 'pi-auto-reviewer-cost';
export const REVIEWER_USAGE_KIND = 'auto-reviewer';
const GENERATION_URL = 'https://openrouter.ai/api/v1/generation';
const LOOKUP_TIMEOUT_MS = 5000;
const MAX_LOOKUP_ATTEMPTS = 6;
const MAX_CONCURRENT_LOOKUPS = 3;

export interface ReviewerCostEvent {
    parentSessionId: string;
    reviewId: string;
    provider: 'openrouter';
    responseId: string;
    model?: string;
    status: 'pending' | 'confirmed' | 'unavailable';
    costUSD?: number;
}

export interface ReviewerCostSummary {
    costUSD: number;
    confirmed: number;
    pending: number;
    unavailable: number;
}

interface ReviewerCostOptions {
    parentSessionId: string;
    reviewId: string;
    getApiKey: () => Promise<string | undefined>;
    report: (event: ReviewerCostEvent) => void;
    fetch?: typeof fetch;
}

export function formatReviewerCost(summary: ReviewerCostSummary): string {
    if (!summary.confirmed && !summary.pending && !summary.unavailable) return '';
    const parts = summary.confirmed ? [`OpenRouter $${summary.costUSD.toFixed(6)}`] : ['OpenRouter cost'];
    if (summary.pending) parts.push(`${summary.pending} pending`);
    if (summary.unavailable) parts.push(`${summary.unavailable} unavailable`);
    return parts.join(' · ');
}

// Domain-level billing API. Parent IDs group accounting; they do not change routing.
export class ReviewerCosts {
    private options: ReviewerCostOptions;
    private records = new Map<string, ReviewerCostEvent>();
    private queue: string[] = [];
    private active = 0;
    private abort = new AbortController();

    constructor(options: ReviewerCostOptions) { this.options = options; }

    observe(message: any): void {
        if (this.abort.signal.aborted || message?.provider !== 'openrouter') return;
        const responseId = message.responseId || `missing:reviewer:${this.options.reviewId}:${this.records.size}`;
        if (this.records.has(responseId)) return;
        this.save({
            parentSessionId: this.options.parentSessionId,
            reviewId: this.options.reviewId, provider: 'openrouter', responseId,
            model: typeof message.model === 'string' ? message.model : undefined,
            status: message.responseId ? 'pending' : 'unavailable',
        });
        if (!message.responseId) return;
        this.queue.push(responseId);
        this.start();
    }

    observeCharge(charge: { provider?: string; responseId?: string; model?: string; costUSD?: unknown }): void {
        if (this.abort.signal.aborted || charge.provider !== 'openrouter') return;
        if (typeof charge.costUSD !== 'number' || !Number.isFinite(charge.costUSD) || charge.costUSD < 0) {
            this.observe(charge);
            return;
        }
        // Some Decisions responses report a charge without a generation ID.
        const responseId = charge.responseId || `billed:reviewer:${this.options.parentSessionId}:${this.options.reviewId}:${this.records.size}`;
        if (this.records.has(responseId)) return;
        this.save({ parentSessionId: this.options.parentSessionId, reviewId: this.options.reviewId,
            provider: 'openrouter', responseId, model: charge.model, status: 'confirmed', costUSD: charge.costUSD });
    }

    summary(): ReviewerCostSummary {
        const total = { costUSD: 0, confirmed: 0, pending: 0, unavailable: 0 };
        for (const record of this.records.values()) {
            total[record.status]++;
            if (record.status === 'confirmed') total.costUSD += record.costUSD!;
        }
        return total;
    }

    dispose(): void { this.abort.abort(); }

    private save(record: ReviewerCostEvent): void {
        this.records.set(record.responseId, record);
        try { this.options.report({ ...record }); } catch { /* Billing observers cannot affect verdicts. */ }
    }

    private start(): void {
        if (this.abort.signal.aborted) return;
        while (this.active < MAX_CONCURRENT_LOOKUPS && this.queue.length) {
            const id = this.queue.shift()!;
            this.active++;
            void this.resolve(id).finally(() => { this.active--; this.start(); });
        }
    }

    private async resolve(responseId: string): Promise<void> {
        try {
            const key = await this.options.getApiKey();
            if (this.abort.signal.aborted) return;
            if (!key) throw new Error('No OpenRouter credential');
            for (let attempt = 0; attempt < MAX_LOOKUP_ATTEMPTS; attempt++) {
                try {
                    const url = new URL(GENERATION_URL);
                    url.searchParams.set('id', responseId);
                    const response = await (this.options.fetch ?? globalThis.fetch)(url, {
                        headers: { Authorization: `Bearer ${key}` },
                        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(LOOKUP_TIMEOUT_MS)]),
                    });
                    if (!response.ok) throw new Error('Billing lookup unavailable');
                    const body = await response.json();
                    const cost = body?.data?.total_cost;
                    if (body?.data?.id !== responseId || typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) throw new Error('Invalid billed cost');
                    if (!this.abort.signal.aborted) this.save({ ...this.records.get(responseId)!, status: 'confirmed', costUSD: cost });
                    return;
                } catch {
                    if (this.abort.signal.aborted) return;
                    if (attempt === MAX_LOOKUP_ATTEMPTS - 1) break;
                    await this.wait(1000 * 2 ** attempt);
                }
            }
        } catch { /* Missing credentials and cancelled waits also leave charges unconfirmed. */ }
        if (!this.abort.signal.aborted) this.save({ ...this.records.get(responseId)!, status: 'unavailable' });
    }

    private wait(ms: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const cancelled = () => { clearTimeout(timer); reject(new Error('Cancelled')); };
            const timer = setTimeout(() => { this.abort.signal.removeEventListener('abort', cancelled); resolve(); }, ms);
            timer.unref();
            this.abort.signal.addEventListener('abort', cancelled, { once: true });
        });
    }
}

// Read subprocess output without changing the decision parser or its output.
export class ReviewerOutput {
    private decoder = new StringDecoder('utf8');
    private buffer = '';
    private unfinished = new Map<string, any>();
    private observe: (message: any) => void;

    constructor(observe: (message: any) => void) { this.observe = observe; }

    write(bytes: Buffer): void {
        this.buffer += this.decoder.write(bytes);
        let newline: number;
        while ((newline = this.buffer.indexOf('\n')) >= 0) {
            this.readLine(this.buffer.slice(0, newline));
            this.buffer = this.buffer.slice(newline + 1);
        }
    }

    end(): void {
        this.buffer += this.decoder.end();
        this.readLine(this.buffer);
        this.buffer = '';
        for (const message of this.unfinished.values()) this.report(message);
        this.unfinished.clear();
    }

    private readLine(line: string): void {
        try {
            const event = JSON.parse(line);
            if (event.message?.role !== 'assistant' || event.message.provider !== 'openrouter') return;
            if (event.type === 'message_update' && event.message.responseId) {
                const { provider, responseId, model, timestamp } = event.message;
                this.unfinished.set(responseId, { provider, responseId, model, timestamp });
                return;
            }
            if (event.type !== 'message_end') return;
            this.unfinished.delete(event.message.responseId);
            this.report(event.message);
        } catch { /* Non-JSON output is still handled by the original decision parser. */ }
    }

    private report(message: any): void {
        try { this.observe(message); } catch { /* Preserve review decisions. */ }
    }
}
