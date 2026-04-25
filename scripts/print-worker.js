import "dotenv/config"
import { execSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3000";
const WORKER_SECRET = process.env.WORKER_SECRET;
const POLL_INTERVAL = 3_000;

const IS_WINDOWS = process.platform === "win32";

const printerArg = process.argv.find(a => a.startsWith("--printer="));

if (!printerArg) {
    console.error("--printer=\"프린터이름\" 인자가 필요합니다.");
    process.exit(1);
}

const PRINTER = printerArg.split("=").slice(1).join('=').replace(/^"|"$/g, "");

const headers = { "x-worker-secret": WORKER_SECRET };

async function pollNext() {
    const res = await fetch(`${API_BASE}/print-queue/next?printerId=${encodeURIComponent(PRINTER)}`, { headers });

    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`Poll 실패: ${res.status}`);

    return res.json();
}

async function reportDone(jobId) {
    await fetch(`${API_BASE}/print-queue/${jobId}/done?printerId=${encodeURIComponent(PRINTER)}`, { method: "POST", headers });
}

async function reportFail(jobId) {
    await fetch(`${API_BASE}/print-queue/${jobId}/fail?printerId=${encodeURIComponent(PRINTER)}`, { method: "POST", headers });
}

async function downloadToTemp(imageUrl) {
    const res = await fetch(imageUrl);

    if (!res.ok) throw new Error(`이미지 다운로드 실패: ${res.status}`);

    const ext = res.headers.get("content-type")?.includes("png") ? "png" : "jpg";
    const buffer = Buffer.from(await res.arrayBuffer());
    const tmpPath = join(tmpdir(), `photobooth_${Date.now()}.${ext}`);

    writeFileSync(tmpPath, buffer);

    return tmpPath;
}

function printFile(filePath) {
    if (IS_WINDOWS) {
        // TODO
    } else {
        execSync(`lpr -P "${PRINTER}" -o media=Custom.4x6in -o print-scaling=fill "${filePath}"`, { timeout: 30_000 });
    }
}

async function processJob(job) {
    let tmpPath = null;

    try {
        console.log(`[${PRINTER}] 작업 시작: ${job.id} (imageUrl: ${job.imageUrl})`);
        tmpPath = await downloadToTemp(job.imageUrl);

        printFile(tmpPath);

        await reportDone(job.id);

        console.log(`[${PRINTER}] 작업 완료: ${job.id}`);
    } catch (err) {
        console.error(`[${PRINTER}] 작업 실패: ${job.id}`, err.message);

        await reportFail(job.id);
    } finally {
        if (tmpPath && existsSync(tmpPath)) unlinkSync(tmpPath);
    }
}

async function loop() {
    while (true) {
        try {
            const job = await pollNext();
            if (job) await processJob(job);
        } catch (err) {
            console.error(`[${PRINTER}] Poll 오류:`, err.message);
        }

        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
}

console.log(`print-worker 시작 | 프린터: "${PRINTER}" | API: ${API_BASE}`);
loop();
