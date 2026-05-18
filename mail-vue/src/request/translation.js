import http from "@/axios/index.js";

export function translateEmail(emailId, targetLang) {
    return http.post('/translation/translate', {emailId, targetLang})
}
