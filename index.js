import "dotenv/config"
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import cors from "@fastify/cors";
import { randomUUID } from "crypto";

import db from "./db.js";
import { uploadImage } from "./r2.js";
import { enqueue, claimNext, markDone, markFailed } from "./queue.js";
import { toPage, parsePageable } from "./pageable.js";
import { generateQR } from "./utils.js";

const app = Fastify({ logger: true });

await app.register(cors, {
    origin: process.env.ALLOWED_ORIGIN.split(","),
    methods: ["GET", "POST"],
});

await app.register(multipart, {
    limits: { fileSize: 20 * 1024 & 1024 } // 20MB
});

function verifyWorker(request, reply) {
    if (request.headers["X-Worker-Secret"] !== process.env.WORKER_SECRET) {
        reply.code(401).send({ status: false, message: "Unauthorized" });

        return false;
    }

    return true;
}

app.get("/", async () => ({ status: true }));

/**
 * POST /photos/upload
 * 사진 업로드
 */
app.post("/photos/upload", async (request, reply) => {
    const data = await request.file();

    if (!data) return reply.code(400), send({ status: false, message: "파일이 없습니다." });

    const { mimetype, filename } = data;

    if (!["image/jpeg", "image/png"].includes(mimetype)) {
        return reply.code(400).send({ status: false, message: "올바르지 않은 이미지 파일 형식입니다." });
    }

    const chunks = [];

    for await (const chunk of data.file) chunks.push(chunk);

    const buffer = Buffer.concat(chunks);

    const imageUrl = await uploadImage(buffer, filename ?? "photo.jpg", mimetype);

    const row = db.prepare(`INSERT INTO photos (image_url) VALUES (?) RETURNING id, image_url`).get(imageUrl);

    return reply.code(200).send({ id: row.id, imageUrl: row.image_url });
});

/**
 * GET /photos
 * 사진 목록 조회 (paginated)
 */
app.get("/photos", async (request, reply) => {
    const { page, size, offset } = parsePageable(request.query);

    const total = db.prepare(`SELECT COUNT(*) as cnt FROM photos`).get().cnt;
    const rows = db.prepare(`SELECT id, image_url FROM photos ORDER BY id DESC LIMIT ? OFFSET ?`).all(size, offset);

    return reply.send(toPage(rows.map((r) => ({ id: r.id, imageUrl: r.image_url })), total, page, size));
});

/**
 * POST /guestbook
 * 방명록 등록
 */
app.post("/guestbook", { schema: { body: { type: "object", required: ["photoId"] } } }, async (request, reply) => {
    const { photoId } = request.body;

    const photo = db.prepare(`SELECT id, image_url FROM photos WHERE id = ?`).get(photoId);

    if (!photo) return reply.code(404).send({ status: false, message: "사진을 찾을 수 없습니다." });

    const row = db.prepare(`INSERT INTO guestbook (photo_id) VALUES (?) RETURNING id, created_at`).get(photoId);

    return reply.code(201).send({ id: row.id, imageUrl: photo.image_url, createdAt: row.created_at });
});

/**
 * GET /guestbook
 * 방명록 조회 (paginated)
 */
app.get("/guestbook", async (request, reply) => {
    const { page, size, offset } = parsePageable(request.query);

    const total = db.prepare(`SELECT COUNT(*) as cnt FROM guestbook`).get().cnt;
    const rows = db.prepare(`
        SELECT g.id, g.created_at, p.image_url
        FROM guestbook g
        JOIN photos p ON p.id = g.photo_id
        ORDER BY g.created_at DESC
        LIMIT ? OFFSET ?
    `).all(size, offset);

    return reply.send(toPage(rows.map((r) => ({ id: r.id, imageUrl: r.image_url, createdAt: r.created_at })), total, page, size));
});

/**
 * POST /share
 * 공유 링크 및 QR 이미지 생성
 */
app.post("/share", { schema: { body: { type: "object", required: ["photoId"] } } }, async (request, reply) => {
    const { photoId } = request.body;

    const photo = db.prepare(`SELECT id, image_url FROM photos WHERE id = ?`).get(photoId);

    if (!photo) return reply.code(404).send({ status: false, message: "사진을 찾을 수 없습니다." });

    const linkUuid = randomUUID();
    const shareUrl = `${process.env.CLIENT_BASE_URL}/share/${linkUuid}`;
    const qrImageBase64 = await generateQR(shareUrl);

    const row = db.prepare(`INSERT INTO share_links (uuid, photo_id) VALUES (?, ?) RETURNING id`).get(linkUuid, photoId);

    return reply.send({ id: row.id, uuid: linkUuid, imageUrl: photo.image_url, qrImageBase64 });
});

/**
 * GET /share/:uuid
 * 공유 링크 조회
 */
app.get("/share/:uuid", async (request, reply) => {
    const { uuid } = request.params;

    const row = db.prepare(`
        SELECT s.id, s.uuid, p.image_url
        FROM share_links s
        JOIN photos p ON p.id = s.photo_id
        WHERE s.uuid = ?
    `).get(uuid);

    if (!row) return reply.code(404).send({ status: false, message: "공유 링크를 찾을 수 없습니다." });

    const shareUrl = `${process.env.CLIENT_BASE_URL}/share/${row.uuid}`;
    const qrImageBase64 = await generateQR(shareUrl);

    return reply.send({ id: row.id, uuid: row.uuid, imageUrl: row.image_url, qrImageBase64 });
});

/**
 * POST /print
 * 인쇄 요청
 */
app.post("/print", { schema: { body: { type: "object", required: ["photoId"] } } }, async (request, reply) => {
    const { photoId } = request.body;

    const photo = db.prepare(`SELECT id, image_url FROM photos WHERE id = ?`).get(photoId);
    if (!photo) return reply.code(404).send({ status: false, message: "사진을 찾을 수 없습니다." });

    const jobId = enqueue(photo.id, photo.image_url);

    return reply.code(201).send({ jobId });
});

/**
 * GET /print/next
 * 다음 인쇄 대상 조회 (worker specific)
 */
app.get("/print-queue/next", async (request, reply) => {
    if (!verifyWorker(request, reply)) return;

    const { printerId } = request.query;

    if (!printerId) return reply.code(400).send({ status: false, message: "printerId가 필요합니다." });

    const job = claimNext(printerId);

    if (!job) return reply.code(204).send();

    return reply.send(job);
});

/**
 * POST /print-queue/:id/done
 * 인쇄 완료 처리 (worker specific)
 */
app.post("/print-queue/:id/done", async (request, reply) => {
    if (!verifyWorker(request, reply)) return;

    const ok = markDone(request.params.id, request.query.printerId);

    if (!ok) return reply.code(404).send({ error: "작업을 찾을 수 없습니다." });

    return reply.send({ status: true });
});

/**
 * POST /print-queue/:id/fail
 * 인쇄 실패 처리 (worker specific)
 */
app.post("/print-queue/:id/fail", async (request, reply) => {
    if (!verifyWorker(request, reply)) return;

    const ok = markFailed(request.params.id, request.query.printerId);

    if (!ok) return reply.code(404).send({ error: "작업을 찾을 수 없습니다." });

    return reply.send({ status: true });
});

const PORT = parseInt(process.env.PORT ?? "3000");
await app.listen({ port: PORT, host: "0.0.0.0" });
