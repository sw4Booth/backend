import jwt from "jsonwebtoken";

export function verifyWorker(request, reply) {
    if (request.headers["x-worker-secret"] !== process.env.WORKER_SECRET) {
        reply.code(401).send({ status: false, message: "Unauthorized" });

        return false;
    }

    return true;
}

export function verifyAdmin(request, reply) {
    const auth = request.headers["authorization"];

    if (!auth?.startsWith("Bearer ")) {
        reply.code(401).send({ status: false, message: "Unauthorized" });

        return false;
    }

    try {
        jwt.verify(auth.slice(7), process.env.JWT_SECRET);

        return true;
    } catch {
        reply.code(401).send({ status: false, message: "Unauthorized" });

        return false;
    }
}
