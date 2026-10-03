FROM public.ecr.aws/e1h7x4a2/plow-cloud-agents:base-31029927e09f1a6465bbb3efcbfcc2c8c66a43a6@sha256:42a6d50f15d67c620f68312d067a1a25ad3b007bf51e6b2e6742b8059ffb4798
USER root
ARG PLOW_HOURS_REVISION
LABEL org.opencontainers.image.source="https://github.com/EnzoTironi/plow-hours" org.opencontainers.image.revision=$PLOW_HOURS_REVISION co.plow.probe="/opt/plow/probe"
COPY plugin /opt/plow/hours-source/plugin
COPY install.mjs probe.mjs backup.mjs /opt/plow/hours-source/
RUN cd /opt/plow && npm install --save-exact --omit=dev --omit=peer --omit=optional --ignore-scripts --no-audit --no-fund zod@4.6.5 && node /opt/plow/hours-source/install.mjs
COPY AGENTS.md /opt/plow/hours-source/AGENTS.md
RUN cat /opt/plow/hours-source/AGENTS.md >> /opt/plow/prompt/AGENTS.md
COPY skill /opt/plow/skills/contractor-hours
ENV PLOW_HOURS=1 PLOW_THREAD_TRUST=untrusted AGENT_ID=plow-hours AGENT_NAME="Plow Hours" AGENT_BLURB="Contractor time tracking through iMessage, with a live timesheet linked to assigned work."
USER node
