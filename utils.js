import QRCode from "qrcode";

export async function generateQR(url) {
    return QRCode.toDataURL(url, {
        width: 300,
        margin: 2,
        errorCorrectionLevel: "M",
    });
}
