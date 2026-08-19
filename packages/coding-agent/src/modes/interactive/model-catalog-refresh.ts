import type { ModelsRefreshResult } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { raceWithAbortSignal } from "../../utils/abort.ts";

type ModelCatalogRuntime = Pick<ModelRuntime, "refresh">;

interface ActiveModelCatalogRefresh {
	controller: AbortController;
	promise: Promise<ModelsRefreshResult>;
	waiters: number;
}

class ModelCatalogRefreshCoordinator {
	// scriptc port: WeakMap has no lowering (SC2020) and Map keys must be string/number.
	// Key on a serial id stamped onto the runtime instead. Divergence: entries are not
	// weakly held, so a runtime that is dropped without completing leaks one entry.
	private readonly activeById = new Map<number, ActiveModelCatalogRefresh>();
	private nextRuntimeId = 1;

	private idOf(modelRuntime: ModelCatalogRuntime): number {
		const tagged = modelRuntime as unknown as { __piRefreshId?: number };
		if (tagged.__piRefreshId === undefined) {
			tagged.__piRefreshId = this.nextRuntimeId;
			this.nextRuntimeId++;
		}
		return tagged.__piRefreshId;
	}

	refresh(modelRuntime: ModelCatalogRuntime, signal: AbortSignal): Promise<ModelsRefreshResult> {
		signal.throwIfAborted();
		const runtimeId = this.idOf(modelRuntime);
		let active = this.activeById.get(runtimeId);
		if (!active) {
			const controller = new AbortController();
			let created!: ActiveModelCatalogRefresh;
			const operation = modelRuntime.refresh({ signal: controller.signal });
			const promise = raceWithAbortSignal(operation, controller.signal).finally(() => {
				if (this.activeById.get(runtimeId) === created) {
					this.activeById.delete(runtimeId);
				}
			});
			created = { controller, promise, waiters: 0 };
			active = created;
			this.activeById.set(runtimeId, active);
		}

		active.waiters++;
		return raceWithAbortSignal(active.promise, signal).finally(() => {
			active.waiters--;
			if (active.waiters === 0 && this.activeById.get(runtimeId) === active) {
				active.controller.abort();
			}
		});
	}
}

const modelCatalogRefreshCoordinator = new ModelCatalogRefreshCoordinator();

/** Share concurrent interactive all-catalog refreshes while keeping each caller's cancellation independent. */
export function refreshModelCatalogs(
	modelRuntime: ModelCatalogRuntime,
	signal: AbortSignal,
): Promise<ModelsRefreshResult> {
	return modelCatalogRefreshCoordinator.refresh(modelRuntime, signal);
}
