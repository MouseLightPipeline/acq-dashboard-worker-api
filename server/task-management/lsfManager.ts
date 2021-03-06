import {spawn} from "child_process";
import * as _ from "lodash";
import * as fs from "fs";
import * as moment from "moment";

const debug = require("debug")("pipeline:worker-api:lsf-manager");

import {CompletionResult, ExecutionStatus, TaskExecution} from "../data-model/local/taskExecution";
import {IJobUpdate, ITaskManager, ITaskUpdateDelegate, ITaskUpdateSource, JobStatus, QueueType} from "./taskSupervisor";
import {killJob, updateJobInfo} from "./lsf";
import {ServiceConfiguration} from "../options/serviceConfig";

const clusterHost = ServiceConfiguration.cluster.submitHost;

export class LSFTaskManager implements ITaskUpdateSource, ITaskManager {
    public static Instance = new LSFTaskManager();

    private _taskUpdateDelegate: ITaskUpdateDelegate;

    public constructor() {
        // Periodically poll cluster job status.
        debug(`Cluster command only set to ${ServiceConfiguration.cluster.generateCommandOnly}`);

        setTimeout(async () => {
            await this.refreshAllJobs();
        }, 10 * 1000);
    }

    public get TaskUpdateDelegate(): ITaskUpdateDelegate {
        return this._taskUpdateDelegate;
    }

    public set TaskUpdateDelegate(delegate: ITaskUpdateDelegate) {
        this._taskUpdateDelegate = delegate;
    }

    private async refreshAllJobs() {
        try {
            const load = await this.pollClusterJobStatus();
            this._taskUpdateDelegate.notifyTaskLoad(QueueType.Cluster, load)
        } catch (err) {
            debug(err);
        }

        setTimeout(() => this.refreshAllJobs(), 20 * 1000);
    }

    private async pollClusterJobStatus(): Promise<number> {
        const running: TaskExecution[] = (await TaskExecution.findRunning()).filter(z => z.queue_type === QueueType.Cluster);

        if (running.length === 0) {
            debug("No running jobs - skipping cluster status check.");
            return 0;
        }

        const ids = running.map(t => t.job_id).filter(j => j > 0).map(j => j.toString());

        if (ServiceConfiguration.cluster.generateCommandOnly) {
            if (this.TaskUpdateDelegate) {
                await Promise.all(running.map(async (o) => {

                    await this.TaskUpdateDelegate.update(o, {
                        id: 0,
                        status: JobStatus.Stopped,
                        exitCode: 0,
                        statistics: null
                    });
                }));
            }

            return;
        }

        const jobInfo: IJobUpdate[] = await updateJobInfo(ids);

        debug(`received ${jobInfo.length} job status updates`);

        if (jobInfo.length > 0) {
            const map = new Map<number, IJobUpdate>();

            jobInfo.map((j) => {
                map.set(j.id, j);
            });

            debug(`found ${running.length} running jobs`);

            const toUpdate: TaskExecution[] = _.intersectionWith(running, jobInfo, (r: TaskExecution, j: IJobUpdate) => {
                return r.job_id === j.id;
            });

            debug(`matched ${toUpdate.length} known jobs for update`);

            if (this.TaskUpdateDelegate) {
                await Promise.all(toUpdate.map(async (o) => {

                    const processInfo = map.get(o.job_id);

                    if (processInfo) {
                        await this.TaskUpdateDelegate.update(o, {
                            id: processInfo.id,
                            status: processInfo.status,
                            exitCode: processInfo.exitCode,
                            statistics: processInfo.statistics
                        });
                    }
                }));
            }
        }

        const zombie: TaskExecution[] = _.differenceWith(running, jobInfo, (r: TaskExecution, j: IJobUpdate) => {
            return r.job_id === j.id;
        });

        debug(`matched ${zombie.length} zombie jobs for removal`);

        await Promise.all(zombie.filter(z => z.queue_type === QueueType.Cluster).map(async (o) => {
            // Only after 15 minutes in case there is any delay between submission and when the job is first
            // available in polling.
            if (Date.now().valueOf() - o.started_at.valueOf() > 15 * 60 * 1000) {
                await this.TaskUpdateDelegate.updateZombie(o);
            }
        }));

        const longRunning = running.map(r => moment.duration(Date.now().valueOf() - r.started_at.valueOf())).filter(d => d.asMinutes() > 60).sort((a, b) => b.asMilliseconds() - a.asMilliseconds());

        if (longRunning.length > 0) {
            debug(`${longRunning.length} cluster tasks have been running longer than 60 minutes`);
            debug(`\tlongest ${longRunning[0].humanize()}`);
            if (longRunning.length > 1) {
                debug(`\tshortest ${longRunning[longRunning.length - 1].humanize()}`);
            }
        }

        return running.reduce((p, t) => {
            return p + t.cluster_work_units;
        }, 0);
    }

    public startTask(taskExecution: TaskExecution) {
        // TODO Need to escape \ and " in any script arguments?
        const programArgs = [taskExecution.resolved_script].concat(JSON.parse(taskExecution.resolved_script_args)).join(" ");

        const jobName = `ml-${taskExecution.tile_id}`;

        const requiredBsubArgs = ["-J", jobName, "-g", `/mouselight/pipeline/${taskExecution.pipeline_stage_id}`, "-oo", `${taskExecution.resolved_log_path + ".cluster.out.log"}`, "-eo", `${taskExecution.resolved_log_path + ".cluster.err.log"}`];

        const clusterArgs = taskExecution.resolved_cluster_args; // .replace(/"/g, `\\"`).replace(/\(/g, `\\(`).replace(/\)/g, `\\)`);

        const clusterCommand = ["bsub"].concat([clusterArgs]).concat(requiredBsubArgs).concat([`'${programArgs}'`]).join(" ");

        const commandScript = taskExecution.resolved_log_path + "-cluster-command.sh";

        fs.writeFileSync(commandScript, `#!/usr/bin/env bash\n\n# Cluster submit file generated ${new Date().toLocaleString()}\n\n${clusterCommand}\n`);
        fs.chmodSync(commandScript, 0o775);

        const sshArgs = [clusterHost, commandScript];

        if (ServiceConfiguration.cluster.generateCommandOnly) {
            return;
        }

        try {
            const submit = spawn(`ssh`, sshArgs);

            submit.stdout.on("data", (data: Buffer) => {
                try {
                    const str = data.toString();

                    const r = str.match(/\d+/);

                    taskExecution.job_id = parseInt(r[0]);
                    taskExecution.job_name = jobName;

                    taskExecution.save().then();

                    debug(`submitted task id ${taskExecution.id} has job id ${taskExecution.job_id}`);
                } catch (err) {
                    debug(err);

                    taskExecution.completed_at = new Date();
                    taskExecution.execution_status_code = ExecutionStatus.Completed;
                    taskExecution.completion_status_code = CompletionResult.Error;
                }
            });

            submit.stderr.on("data", (data: Buffer) => {
                debug(`ssh ${clusterHost} submission error:`);
                debug(data.toString());

                fs.appendFileSync(taskExecution.resolved_log_path + ".cluster.err.log", `ssh ${clusterHost} submission error:`);
                fs.appendFileSync(taskExecution.resolved_log_path + ".cluster.err.log", data.toString());
            });

            submit.on("close", (code) => {
                if (code === 0) {
                    debug(`submitted task id ${taskExecution.id}`);
                } else {
                    debug(`failed to submit task id ${taskExecution.id} with exit code ${code}`);

                    taskExecution.completed_at = new Date();
                    taskExecution.execution_status_code = ExecutionStatus.Completed;
                    taskExecution.completion_status_code = CompletionResult.Error;
                }

                taskExecution.save().then();
            });
        } catch (err) {
            debug(err);

            taskExecution.completed_at = new Date();
            taskExecution.execution_status_code = ExecutionStatus.Completed;
            taskExecution.completion_status_code = CompletionResult.Error;

            taskExecution.save().then();
        }
    }

    public async stopTask(taskExecutionId: string) {
        const taskExecution = await TaskExecution.findByPk(taskExecutionId);

        await killJob(taskExecution.job_id);
    }
}
