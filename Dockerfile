FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY index.html style.css app.js server-auth.js ./

RUN mkdir -p /data
ENV DATA_DIR=/data
ENV PORT=8080

EXPOSE 8080
VOLUME ["/data"]

CMD ["node", "server-auth.js"]
