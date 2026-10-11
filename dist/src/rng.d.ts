import type { RngState, RngStream } from './types';
export interface RngController extends RngStream {
    exportState(): RngState;
    restoreState(snapshot: RngState): void;
}
export declare const createRng: (seed?: number) => RngController;
