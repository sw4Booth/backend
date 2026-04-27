const queue = new Map();

const JobStatus = Object.freeze({
    PENDING: "pending",
    PRINTING: "printing",
    COMPLETED: "completed",
    FAILED: "failed"
});

function makeId() {
    return `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export function enqueue(imageUrl) {
    const id = makeId();

    queue.set(id, {
        id,
        imageUrl,
        status: JobStatus.PENDING,
        printerId: null,
        createdAt: Date.now(),
        claimedAt: null
    });

    return id;
}

export function claimNext(printerId) {
    for (const job of queue.values()) {
        if (job.status === JobStatus.PENDING) {
            job.status = JobStatus.PRINTING;
            job.printerId = printerId;
            job.claimedAt = Date.now();

            return job;
        }
    }

    return null;
}

export function markDone(jobId, printerId) {
    const job = queue.get(jobId);

    if (!job || job.printerId !== printerId || job.status !== JobStatus.PRINTING) return false;

    job.status = JobStatus.COMPLETED;

    return true;
}

export function markFailed(jobId, printerId) {
    const job = queue.get(jobId);

    if (!job || job.printerId !== printerId) return false;

    job.status = JobStatus.FAILED;
    job.claimedAt = null;

    return true;
}

export function getAll() {
    return [...queue.values()];
}

export function retry(jobId) {
    const job = queue.get(jobId);

    if (!job || job.status !== JobStatus.FAILED) return false;

    job.status = JobStatus.PENDING;
    job.printerId = null;
    job.claimedAt = null;

    return true;
}

export function remove(jobId) {
    if (!queue.has(jobId)) return false;

    queue.delete(jobId);

    return true;
}

export { queue };
