export function parsePageable(query) {
    const page = Math.max(0, parseInt(query.page ?? "0"));
    const size = Math.min(100, Math.max(1, parseInt(query.size ?? "20")));

    return { page, size, offset: page * size };
}

export function toPage(content, totalElements, page, size) {
    return {
        content,
        totalPages: Math.ceil(totalElements / size) || 1,
        totalElements,
        page,
        size
    }
}
