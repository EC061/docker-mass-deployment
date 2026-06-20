# Default lab base image: an SSH-accessible Ubuntu with sudo + Python.
#
# Students are added later as Linux users by the agent (docker exec useradd ...), so this image does
# NOT create users at boot. The agent bind-mounts lab data at /labdata/{fast,slow} and per-student
# datasets under /labusers/{fast,slow}; the agent wires each student's ~/scratch and ~/cold-storage.
#
# Build + tag for use as a lab image:
#   docker build -t custom-ssh ./image

FROM ubuntu:noble

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        openssh-server sudo python3-pip python3-venv curl nano ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && mkdir -p /var/run/sshd /labdata /labusers

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
CMD ["/usr/sbin/sshd", "-D", "-e"]
