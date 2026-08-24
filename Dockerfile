FROM oven/bun:1-alpine
WORKDIR /app
COPY server/ /app/
RUN mkdir -p /data && chown -R bun:bun /app /data
USER bun
ENV PORT=9998 HOST=0.0.0.0 LOG_LEVEL=info DATA_DIR=/data
EXPOSE 9998
CMD ["bun", "run", "/app/v4-server.ts"]
