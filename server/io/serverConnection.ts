const debug = require("debug")("pipeline:worker-api:message-queue");

import {ITaskExecutionAttributes} from "../data-model/sequelize/taskExecution";
import {LocalPersistentStorageManager} from "../data-access/local/databaseConnector";
import {MachineProperties} from "../system/systemProperties";
import {IWorker} from "../data-model/sequelize/worker";
import {ICoordinatorService} from "../options/coreServicesOptions";
import {ServiceConfiguration} from "../options/serviceConfig";
import {QueueType} from "../task-management/taskSupervisor";
import {MainQueue} from "../message-queue/mainQueue";


export class SocketIoClient {
    private static _UPDATE_INTERVAL_MINUTES = 10;
    private static _HEARTBEAT_INTERVAL_SECONDS = 10;

    private static _ioClient: SocketIoClient = null;

    public static async use(worker: IWorker, coordinatorService: ICoordinatorService) {
        if (this._ioClient === null) {
            this._ioClient = new SocketIoClient(worker, coordinatorService);
            await this._ioClient.start();
        }
    }

    private readonly _url: string;
    private readonly _worker: IWorker;

    private _heartBeatInterval = null;
    private _updateInterval = null;

    private _localStorageManager = LocalPersistentStorageManager.Instance();

    private constructor(worker: IWorker, coordinatorService: ICoordinatorService) {
        this._worker = worker;
        this._url = `http://${coordinatorService.host}:${coordinatorService.port}`;
    }

    public async start() {
        this.emitHostInformation();

        if (!this._updateInterval) {
            this._updateInterval = setInterval(() => this.emitHeartBeat(), SocketIoClient._UPDATE_INTERVAL_MINUTES * 60 * 1000);
        }

        await this.emitHeartBeat();

        if (!this._heartBeatInterval) {
            this._heartBeatInterval = setInterval(() => this.emitHeartBeat(), SocketIoClient._HEARTBEAT_INTERVAL_SECONDS * 1000);
        }
    }

    private emitHostInformation() {

        MainQueue.Instance.StatusChannel.sendStatus({
            worker: this._worker,
            service: ServiceConfiguration,
            machine: MachineProperties
        });
    }

    private async emitHeartBeat() {
        try {
            let localTaskLoad = 0;
            let clusterTaskLoad = 0;

            const tasks: ITaskExecutionAttributes[] = await this._localStorageManager.TaskExecutions.findRunning();

            tasks.map((t) => {
                if (t.queue_type === QueueType.Local) {
                    localTaskLoad += t.local_work_units;
                } else {
                    clusterTaskLoad += t.cluster_work_units;
                }
            });

            MainQueue.Instance.StatusChannel.sendHeartbeat({
                worker: this._worker.toJSON(),
                localTaskLoad,
                clusterTaskLoad
            });
        } catch (err) {
            debug("failed to emit heartbeat");
            debug(err);
        }
    }
}
